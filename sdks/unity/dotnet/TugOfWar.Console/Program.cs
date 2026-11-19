// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.IO;
using PlayerThree.Samples.TugOfWar;
using PlayerThree.Sidecar;

// Tug of War as a plain .NET "dedicated server": the engine owns the simulation and the clock, the PlayerThree sidecar
// owns MCP. Usage:
//   TugOfWar.Console                       spawn `node <repo>/packages/sidecar/bin/playerthree-sidecar.ts --stdio`
//   TugOfWar.Console [--] <command> [args…]  spawn another host over stdio (e.g. the conformance runner)
// Diagnostics go to stderr. The seat token is never printed: it goes to an owner-only file whose path, with the MCP URL,
// goes to stdout for the operator.
internal static class Program
{
    private static int Main(string[] args)
    {
        PlayerThreeSidecar sidecar = null;
        try
        {
            var transport = SidecarTransport.FromEnvironment() ?? Spawn(args);
            sidecar = PlayerThreeSidecar.Start(transport, new SidecarOptions
            {
                Manifest = Tug.Manifest(),
                Game = new TugGame(),
                Hooks = HookSet.Of<TugMatch>(),
                Log = Log,
            });
            Log($"ready, surface {sidecar.SurfaceHash}");
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cancelled = true; };

            var session = sidecar.CreateMatch(JsonValue.Parse(
                "{\"seed\":1,\"controllers\":{\"north\":{\"puller\":\"agent\"},\"south\":{\"puller\":\"bot\"}},\"botLevel\":{\"south\":\"easy\"}}"));
            var token = sidecar.MintSeatToken(session, new Seat("north", "puller"));
            var tokenFile = SeatTokenFile.Write(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolderOption.Create), "playerthree", "tug-seat-token"), token);
            Console.Out.WriteLine($"MCP endpoint: {sidecar.McpUrl}");
            Console.Out.WriteLine($"north/puller seat token (owner-only file): {tokenFile}");
            Console.Out.WriteLine($"  claude mcp add --transport http tug {sidecar.McpUrl} --header \"Authorization: Bearer $(cat '{tokenFile}')\"");
            Console.Out.Flush();

            // Engine-owned clock: one tick per 100 ms (manifest tickRate 10), answering host calls in between.
            var tick = 0;
            while (!sidecar.HasEnded(session) && !cancelled)
            {
                try { tick = sidecar.Step(session, 1); }
                catch (SidecarRequestException e) when (e.Code == "paused") { /* an absent agent paused it; keep serving calls */ }
                catch (SidecarRequestException e) when (e.Code == "over") { break; }
                sidecar.Pump(100);
            }
            var match = (TugMatch)sidecar.Match(session);
            Log($"match over at tick {tick}: rope {match?.Rope}, north {match?.Outcome("north")}");

            try { sidecar.DisposeSession(session); }
            catch (SidecarClosedException e)
            {
                // The host may end the connection around our release (a conformance limit check does); the match is over.
                Log($"connection closed while releasing the session: {e.Reason}");
                return 0;
            }
            // Keep answering until the host closes the connection (or Ctrl-C).
            while (sidecar.IsConnected && !cancelled) sidecar.Pump(250);
            return 0;
        }
        catch (SidecarClosedException e)
        {
            Log($"sidecar closed: {e.Message}");
            return 1;
        }
        catch (SidecarRequestException e)
        {
            Log(e.Message);
            return 1;
        }
        finally
        {
            sidecar?.Dispose();
        }
    }

    private static volatile bool cancelled;

    private static void Log(string line) => Console.Error.WriteLine("[tug] " + line);

    /// <summary>
    /// Every argument is the host command line. A leading `--` is optional: `dotnet run` consumes its own `--`, so
    /// `dotnet run --project TugOfWar.Console -- node run.ts --stdio` reaches us as `node run.ts --stdio`, while
    /// `dotnet TugOfWar.Console.dll -- node run.ts --stdio` keeps it.
    /// </summary>
    private static SidecarTransport Spawn(string[] args)
    {
        var start = args.Length > 0 && args[0] == "--" ? 1 : 0;
        if (start < args.Length)
        {
            var rest = new List<string>();
            for (var i = start + 1; i < args.Length; i++) rest.Add(args[i]);
            return SidecarTransport.Spawn(args[start], rest, Log);
        }
        var bin = FindSidecarBin() ?? throw new FileNotFoundException("packages/sidecar/bin/playerthree-sidecar.ts not found above " + AppContext.BaseDirectory + "; pass the host command as arguments");
        return SidecarTransport.Spawn("node", new[] { bin, "--stdio" }, Log);
    }

    /// <summary>The sidecar host of the checkout this sample lives in.</summary>
    private static string FindSidecarBin()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "packages", "sidecar", "bin", "playerthree-sidecar.ts");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }
}
