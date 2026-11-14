// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using UnityEngine;

namespace PlayerThree.Sidecar.Unity
{
    /// <summary>
    /// Runs one PlayerThree sidecar connection from a Unity server scene: answers host calls every frame
    /// (<c>Update</c>), drives the match clock from <c>FixedUpdate</c> at the manifest's <c>tickRate</c> (scaled by
    /// <c>Time.timeScale</c>), and closes the connection when destroyed. Every adapter call runs on Unity's main thread.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class PlayerThreeSidecarRunner : MonoBehaviour
    {
        [Tooltip("Host executable to spawn over stdio (ignored when a socket path is set).")]
        public string sidecarCommand = "node";

        [Tooltip("Arguments of the host command; relative paths resolve against the working directory (the project folder in the Editor).")]
        public string[] sidecarArguments = { "../player-three/packages/sidecar/bin/playerthree-sidecar.ts", "--stdio" };

        [Tooltip("Connect to a host already listening on this Unix socket or named pipe instead of spawning one. Empty: use PLAYERTHREE_SIDECAR_SOCKET when set.")]
        public string socketPath = "";

        [Tooltip("Longest wait for one host request (advance, createMatch, …), in milliseconds.")]
        public int requestTimeoutMs = 60000;

        [Tooltip("Most ticks one FixedUpdate may advance when catching up; excess game time is dropped.")]
        public int maxTicksPerFixedUpdate = 4;

        private double _tickRate;
        private double _owed;
        private bool _clockRunning;

        /// <summary>The live connection, or null before <see cref="Connect"/> and after it closed.</summary>
        public PlayerThreeSidecar Sidecar { get; private set; }
        /// <summary>The match session the clock drives, or null.</summary>
        public string Session { get; private set; }

        /// <summary>The host ended the current match (its <c>ended</c> push); the clock has stopped.</summary>
        public event Action<string> MatchEnded;
        /// <summary>Every host push (main thread).</summary>
        public event Action<SidecarPush> Pushed;
        /// <summary>The connection closed; the host disposed every session. Move agent and policy seats to the game's own bots.</summary>
        public event Action<SidecarClosedException> Disconnected;

        /// <summary>Connects (spawning the host or using the socket) and completes the <c>hello</c>/<c>ready</c> handshake.</summary>
        public void Connect(JsonValue manifest, IGame game, Hooks hooks)
        {
            if (Sidecar != null) throw new InvalidOperationException("already connected");
            var path = string.IsNullOrEmpty(socketPath) ? Environment.GetEnvironmentVariable(SidecarTransport.SocketEnvironmentVariable) : socketPath;
            var transport = string.IsNullOrEmpty(path)
                ? SidecarTransport.Spawn(sidecarCommand, sidecarArguments, line => Debug.Log("[playerthree-sidecar] " + line))
                : SidecarTransport.Connect(path);
            Sidecar = PlayerThreeSidecar.Start(transport, new SidecarOptions
            {
                Manifest = manifest,
                Game = game,
                Hooks = hooks,
                RequestTimeoutMs = requestTimeoutMs,
                Log = line => Debug.LogWarning(line),
            });
            _tickRate = manifest["tickRate"].AsDouble();
            Sidecar.Pushed += OnPushed;
            Sidecar.Closed += OnClosed;
        }

        /// <summary><c>createMatch</c> with plain-JSON options, then starts the clock for that session.</summary>
        public string BeginMatch(JsonValue createMatchOptions)
        {
            if (Sidecar == null) throw new InvalidOperationException("Connect first");
            if (Session != null) throw new InvalidOperationException("a match is already running; EndMatch first");
            Session = Sidecar.CreateMatch(createMatchOptions);
            _owed = 0;
            _clockRunning = true;
            return Session;
        }

        /// <summary>Stops the clock and releases the session on the host.</summary>
        public void EndMatch()
        {
            if (Session == null) return;
            var session = Session;
            Session = null;
            _clockRunning = false;
            if (Sidecar != null && Sidecar.IsConnected) Sidecar.DisposeSession(session);
        }

        private void Update()
        {
            if (Sidecar != null && Sidecar.IsConnected) Sidecar.Pump();
        }

        private void FixedUpdate()
        {
            if (!_clockRunning || Sidecar == null || !Sidecar.IsConnected) return;
            _owed += Time.fixedDeltaTime * _tickRate;
            var ticks = (int)Math.Floor(_owed);
            if (ticks < 1) return;
            if (ticks > maxTicksPerFixedUpdate)
            {
                ticks = maxTicksPerFixedUpdate;
                _owed = 0;
            }
            else _owed -= ticks;
            try
            {
                Sidecar.Step(Session, ticks);
            }
            catch (SidecarRequestException e) when (e.Code == "paused")
            {
                _owed = 0; // an absent seat paused the session (whenAbsent: pause); time does not accrue
            }
            catch (SidecarRequestException e) when (e.Code == "over")
            {
                _clockRunning = false;
            }
            catch (SidecarClosedException)
            {
                _clockRunning = false; // OnClosed reports it
            }
        }

        private void OnPushed(SidecarPush push)
        {
            Pushed?.Invoke(push);
            if (push.Kind == "ended" && push.Session == Session)
            {
                _clockRunning = false;
                MatchEnded?.Invoke(push.Session);
            }
        }

        private void OnClosed(SidecarClosedException e)
        {
            _clockRunning = false;
            Debug.LogWarning("PlayerThree sidecar disconnected: " + e.Message);
            Disconnected?.Invoke(e);
        }

        private void OnDestroy()
        {
            _clockRunning = false;
            Session = null;
            Sidecar?.Dispose();
            Sidecar = null;
        }
    }
}
