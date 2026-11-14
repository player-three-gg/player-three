// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using PlayerThree.Sidecar;
using PlayerThree.Sidecar.Unity;
using UnityEngine;

namespace PlayerThree.Samples.TugOfWar
{
    /// <summary>
    /// The Tug of War sample scene's script: put it on a GameObject (it adds a <see cref="PlayerThreeSidecarRunner"/>),
    /// press Play or start a headless server build. North is an MCP agent seat, south the built-in <c>easy</c> bot.
    /// The seat token goes to an owner-only file under <c>Application.persistentDataPath</c>; only its path is shown.
    /// </summary>
    [RequireComponent(typeof(PlayerThreeSidecarRunner))]
    public sealed class TugOfWarServer : MonoBehaviour
    {
        private PlayerThreeSidecarRunner _runner;
        private string _connect = "";
        private string _status = "connecting…";

        private void Start()
        {
            _runner = GetComponent<PlayerThreeSidecarRunner>();
            _runner.MatchEnded += OnMatchEnded;
            _runner.Disconnected += e => _status = "sidecar disconnected: " + e.Reason;
            _runner.Connect(Tug.Manifest(), new TugGame(), HookSet.Of<TugMatch>());

            var session = _runner.BeginMatch(JsonValue.Parse(
                "{\"seed\":1,\"controllers\":{\"north\":{\"puller\":\"agent\"},\"south\":{\"puller\":\"bot\"}},\"botLevel\":{\"south\":\"easy\"}}"));
            var token = _runner.Sidecar.MintSeatToken(session, new Seat("north", "puller"));
            var tokenFile = SeatTokenFile.Write(System.IO.Path.Combine(Application.persistentDataPath, "tug-seat-token"), token);
            _connect = $"claude mcp add --transport http tug {_runner.Sidecar.McpUrl} --header \"Authorization: Bearer $(cat '{tokenFile}')\"";
            Debug.Log($"Tug of War: MCP {_runner.Sidecar.McpUrl}; north/puller seat token in {tokenFile}");
            _status = "match " + session + " running";
        }

        private void OnMatchEnded(string session)
        {
            var match = (TugMatch)_runner.Sidecar.Match(session);
            _status = $"match over at tick {match.Tick}: north {match.Outcome("north")}, rope {match.Rope}";
            Debug.Log(_status);
            _runner.EndMatch();
        }

        private void OnGUI()
        {
            var match = _runner != null && _runner.Session != null ? _runner.Sidecar?.Match(_runner.Session) as TugMatch : null;
            GUILayout.BeginArea(new Rect(10, 10, 900, 140));
            GUILayout.Label("Tug of War — " + _status);
            if (match != null) GUILayout.Label($"tick {match.Tick}   rope {match.Rope} (+10 north wins, -10 south wins)");
            GUILayout.Label("Connect an agent to the north seat:");
            GUILayout.TextField(_connect);
            GUILayout.EndArea();
        }
    }
}
