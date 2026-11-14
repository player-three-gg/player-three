// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace PlayerThree.Sidecar
{
    /// <summary>
    /// Hands a seat token to its owner without logging it: the token goes into a file only the current OS user can
    /// read, and the game logs the file's path instead. On Unix the file is created empty and set to mode 0600 before the
    /// token is written; on Windows it relies on the per-user ACL of the directory (use a folder under the user profile,
    /// such as <c>%LOCALAPPDATA%</c>).
    /// </summary>
    public static class SeatTokenFile
    {
        private const uint OwnerReadWrite = 0x180; // 0600

        [DllImport("libc", SetLastError = true)]
        private static extern int chmod(string path, uint mode);

        /// <summary>Writes <paramref name="token"/> (plus a newline) to <paramref name="path"/>, creating its directory; returns the full path.</summary>
        public static string Write(string path, string token)
        {
            if (token == null) throw new ArgumentNullException(nameof(token));
            var full = Path.GetFullPath(path ?? throw new ArgumentNullException(nameof(path)));
            var dir = Path.GetDirectoryName(full);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            using (var file = new FileStream(full, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && chmod(full, OwnerReadWrite) != 0)
                {
                    var errno = Marshal.GetLastWin32Error();
                    file.Dispose();
                    File.Delete(full);
                    throw new IOException($"could not restrict {full} to its owner (errno {errno}); the token was not written");
                }
                var bytes = Encoding.UTF8.GetBytes(token + "\n");
                file.Write(bytes, 0, bytes.Length);
            }
            return full;
        }
    }
}
