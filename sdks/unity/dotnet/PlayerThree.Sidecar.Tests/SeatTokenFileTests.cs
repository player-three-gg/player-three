// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.IO;
using PlayerThree.Sidecar;
using Xunit;

public class SeatTokenFileTests
{
    [Fact]
    public void WritesTheTokenToAnOwnerOnlyFile()
    {
        var dir = Path.Combine(Path.GetTempPath(), "p3-token-test-" + Guid.NewGuid().ToString("N"));
        try
        {
            var path = SeatTokenFile.Write(Path.Combine(dir, "nested", "tug-seat-token"), "secret-token");
            Assert.Equal("secret-token\n", File.ReadAllText(path));
            if (!OperatingSystem.IsWindows())
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));

            // Rewriting an existing, wider file narrows it again before the new token goes in.
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, (UnixFileMode)0b110_100_100);
            SeatTokenFile.Write(path, "rotated");
            Assert.Equal("rotated\n", File.ReadAllText(path));
            if (!OperatingSystem.IsWindows())
                Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
        }
        finally
        {
            if (Directory.Exists(dir)) Directory.Delete(dir, true);
        }
    }
}
