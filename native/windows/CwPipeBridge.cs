// CwPipeBridge.cs - Windows protected named-pipe bridge for CW Station.
//
// Purpose (ADR0006 / P1-003 v2):
//   Node/libuv creates named pipes with a NULL SECURITY_ATTRIBUTES, so the pipe gets the
//   Windows default named-pipe DACL - not the process token default DACL. Tightening the
//   DACL after listen does not revoke already-granted handles. This helper creates the pipe
//   with an explicit protected DACL *at creation time* (current user + SYSTEM allow,
//   NETWORK deny) and PIPE_REJECT_REMOTE_CLIENTS, then reads the descriptor back and refuses
//   to report ready unless owner and ACEs match. It forwards the raw pipe byte stream over
//   inherited anonymous stdin/stdout using a bound, versioned frame protocol.
//
//   client mode opens the pipe once with CreateFileW and verifies the server process token
//   user and the actual ACL *on that same handle* before forwarding any RPC bytes, so there
//   is no probe-then-connect race (TOCTOU).
//
// Target: C# 5 / .NET Framework 4.x compiled with the in-box Framework64 csc. No runtime
// compilation, no NuGet, no TCP, no extra named pipe.
//
// Modes:
//   server --pipe <name> --parent <pid> [--max-connections N] [--write-queue N]
//          [--write-timeout-ms N] [--max-frame-bytes N]
//   client --pipe <name> --parent <pid> [--connect-timeout-ms N]
//   acltest --pipe <name>            Read back a live pipe's SD and run AccessCheck.
//
// stdio protocol (internal, version 1, one JSON object per line):
//   bridge -> node:
//     {"v":1,"t":"ready", ...}
//     {"v":1,"t":"conn","id":N}
//     {"v":1,"t":"data","id":N,"b":"<base64>"}
//     {"v":1,"t":"close","id":N}
//     {"v":1,"t":"fatal","message":"..."}
//   node -> bridge:
//     {"v":1,"t":"data","id":N,"b":"<base64>"}
//     {"v":1,"t":"close","id":N}
//     {"v":1,"t":"shutdown"}
//   stdout carries protocol frames only; stderr carries human diagnostics.

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Security.AccessControl;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace CwStation.PipeBridge
{
    internal sealed class BridgeFatalException : Exception
    {
        public readonly int Win32Error;
        public BridgeFatalException(string message, int win32Error) : base(message)
        {
            Win32Error = win32Error;
        }
    }

    internal static class Win32
    {
        public const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        [StructLayout(LayoutKind.Sequential)]
        private struct Overlapped {
            public IntPtr Internal, InternalHigh;
            public uint Offset, OffsetHigh;
            public IntPtr Event;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, IntPtr name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetOverlappedResult(IntPtr handle, IntPtr overlapped, out uint bytes, bool wait);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CancelIoEx(IntPtr handle, IntPtr overlapped);
        public static bool Accept(IntPtr handle) {
            IntPtr ev = CreateEventW(IntPtr.Zero, true, false, IntPtr.Zero);
            if (ev == IntPtr.Zero) throw new BridgeFatalException("accept event creation failed", Marshal.GetLastWin32Error());
            IntPtr ov = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Overlapped)));
            try {
                Marshal.StructureToPtr(new Overlapped { Event = ev }, ov, false);
                if (ConnectNamedPipe(handle, ov)) return true;
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_PIPE_CONNECTED) return true;
                if (error != 997) throw new BridgeFatalException("accept failed", error);
                WaitForSingleObject(ev, INFINITE);
                uint bytes;
                if (!GetOverlappedResult(handle, ov, out bytes, false)) throw new BridgeFatalException("accept completion failed", Marshal.GetLastWin32Error());
                return true;
            } finally { Marshal.FreeHGlobal(ov); CloseHandle(ev); }
        }
        public const uint GENERIC_READ = 0x80000000;
        public const uint GENERIC_WRITE = 0x40000000;
        public const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        public const uint PIPE_ACCESS_DUPLEX = 0x00000003;
        public const uint PIPE_TYPE_BYTE = 0x00000000;
        public const uint PIPE_READMODE_BYTE = 0x00000000;
        public const uint PIPE_WAIT = 0x00000000;
        public const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
        public const uint PIPE_UNLIMITED_INSTANCES = 255;
        public const uint OPEN_EXISTING = 3;

        public const int ERROR_FILE_NOT_FOUND = 2;
        public const int ERROR_ACCESS_DENIED = 5;
        public const int ERROR_PIPE_BUSY = 231;
        public const int ERROR_PIPE_CONNECTED = 535;
        public const int ERROR_BROKEN_PIPE = 109;
        public const int ERROR_NO_DATA = 232;

        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint SYNCHRONIZE = 0x00100000;
        public const uint TOKEN_QUERY = 0x0008;
        public const uint TOKEN_DUPLICATE = 0x0002;
        public const uint INFINITE = 0xFFFFFFFF;

        public const int SE_KERNEL_OBJECT = 6;
        public const uint OWNER_SECURITY_INFORMATION = 0x00000001;
        public const uint GROUP_SECURITY_INFORMATION = 0x00000002;
        public const uint DACL_SECURITY_INFORMATION = 0x00000004;
        public const uint SDDL_REVISION_1 = 1;

        public const int TokenUser = 1;
        public const int SecurityImpersonation = 2;
        public const int TokenImpersonation = 2;

        public const uint FILE_GENERIC_READ = 0x120089;
        public const uint FILE_GENERIC_WRITE = 0x120116;
        public const uint FILE_GENERIC_EXECUTE = 0x1200A0;
        public const uint FILE_ALL_ACCESS = 0x1F01FF;

        public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SID_AND_ATTRIBUTES
        {
            public IntPtr Sid;
            public uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct GENERIC_MAPPING
        {
            public uint GenericRead;
            public uint GenericWrite;
            public uint GenericExecute;
            public uint GenericAll;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateNamedPipeW")]
        public static extern IntPtr CreateNamedPipeW(string lpName, uint dwOpenMode, uint dwPipeMode, uint nMaxInstances,
            uint nOutBufferSize, uint nInBufferSize, uint nDefaultTimeOut, IntPtr lpSecurityAttributes);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateNamedPipeW")]
        public static extern IntPtr CreateNamedPipeWithSdW(string lpName, uint dwOpenMode, uint dwPipeMode, uint nMaxInstances,
            uint nOutBufferSize, uint nInBufferSize, uint nDefaultTimeOut, ref SECURITY_ATTRIBUTES lpSecurityAttributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ConnectNamedPipe(IntPtr hNamedPipe, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool DisconnectNamedPipe(IntPtr hNamedPipe);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateFileW")]
        public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
            IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "WaitNamedPipeW")]
        public static extern bool WaitNamedPipeW(string lpNamedPipeName, uint nTimeOut);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead,
            out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteFile(IntPtr hFile, IntPtr lpBuffer, uint nNumberOfBytesToWrite,
            out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FlushFileBuffers(IntPtr hFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint serverProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool GetTokenInformation(IntPtr tokenHandle, int tokenInformationClass,
            IntPtr tokenInformation, uint tokenInformationLength, out uint returnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool DuplicateTokenEx(IntPtr existingToken, uint desiredAccess, IntPtr tokenAttributes,
            int impersonationLevel, int tokenType, out IntPtr newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool CreateRestrictedToken(IntPtr existingToken, uint flags, uint disableSidCount,
            IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount,
            IntPtr sidsToRestrict, out IntPtr newToken);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool EqualSid(IntPtr pSid1, IntPtr pSid2);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertStringSecurityDescriptorToSecurityDescriptorW")]
        public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string stringSecurityDescriptor,
            uint stringSdRevision, out IntPtr securityDescriptor, out uint securityDescriptorSize);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertSecurityDescriptorToStringSecurityDescriptorW")]
        public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr securityDescriptor,
            uint requestedStringSdRevision, uint securityInformation, out IntPtr stringSecurityDescriptor,
            out uint stringSecurityDescriptorLength);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertStringSidToSidW")]
        public static extern bool ConvertStringSidToSidW(string stringSid, out IntPtr sid);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertSidToStringSidW")]
        public static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr stringSid);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern uint GetSecurityInfo(IntPtr handle, int objectType, uint securityInformation,
            out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        public static extern bool AccessCheck(IntPtr securityDescriptor, IntPtr clientToken, uint desiredAccess,
            ref GENERIC_MAPPING genericMapping, IntPtr privilegeSet, ref uint privilegeSetLength,
            out uint grantedAccess, [MarshalAs(UnmanagedType.Bool)] out bool accessStatus);

        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
    }

    internal static class Frames
    {
        public const int ProtocolVersion = 1;

        private static readonly object StdoutLock = new object();
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();
        private static Stream _stdout;
        private static Stream _stderr;

        public static void Initialize()
        {
            _stdout = Console.OpenStandardOutput();
            _stderr = Console.OpenStandardError();
        }

        public static void Diag(string message)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes("CwPipeBridge: " + message + Environment.NewLine);
                _stderr.Write(bytes, 0, bytes.Length);
                _stderr.Flush();
            }
            catch
            {
                // Diagnostics must never break the bridge.
            }
        }

        public static void Emit(Dictionary<string, object> frame)
        {
            using (var deadline = new Timer(delegate { Environment.Exit(5); }, null, 5000, Timeout.Infinite))
            {
            frame["v"] = ProtocolVersion;
            string json;
            lock (Serializer)
            {
                json = Serializer.Serialize(frame);
            }
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            lock (StdoutLock)
            {
                _stdout.Write(bytes, 0, bytes.Length);
                _stdout.WriteByte(0x0a);
                _stdout.Flush();
            }
            }
        }

        public static string ReadLine(TextReader reader)
        {
            var line = new StringBuilder();
            for (;;) {
                int ch = reader.Read();
                if (ch < 0) return line.Length == 0 ? null : line.ToString();
                if (ch == 10) return line.ToString();
                if (line.Length >= 128 * 1024) throw new BridgeFatalException("internal frame too large", 0);
                line.Append((char)ch);
            }
        }

        public static Dictionary<string, object> Parse(string line)
        {
            var serializer = new JavaScriptSerializer();
            object parsed = serializer.DeserializeObject(line);
            var dict = parsed as Dictionary<string, object>;
            if (dict == null) throw new BridgeFatalException("frame is not a JSON object", 0);
            object version;
            if (!dict.TryGetValue("v", out version) || !(version is int) || (int)version != ProtocolVersion)
                throw new BridgeFatalException("unsupported internal frame version", 0);
            return dict;
        }

        public static string GetString(Dictionary<string, object> frame, string key)
        {
            object value;
            if (!frame.TryGetValue(key, out value) || value == null) return null;
            return value as string;
        }

        public static int GetInt(Dictionary<string, object> frame, string key)
        {
            object value;
            if (!frame.TryGetValue(key, out value) || value == null)
                throw new BridgeFatalException("frame is missing field " + key, 0);
            if (!(value is int) || (int)value < 1) throw new BridgeFatalException("invalid connection id", 0);
            return (int)value;
        }

        public static Dictionary<string, object> Data(int id, byte[] payload)
        {
            return new Dictionary<string, object>
            {
                { "t", "data" },
                { "id", id },
                { "b", Convert.ToBase64String(payload) },
            };
        }

        public static Dictionary<string, object> Conn(int id)
        {
            return new Dictionary<string, object> { { "t", "conn" }, { "id", id } };
        }

        public static Dictionary<string, object> Close(int id)
        {
            return new Dictionary<string, object> { { "t", "close" }, { "id", id } };
        }

        public static void Ack(int id, int seq)
        {
            if (seq > 0) Emit(new Dictionary<string, object> { { "t", "ack" }, { "id", id }, { "seq", seq } });
        }

        public static void Fatal(string message)
        {
            Diag("fatal: " + message);
            Emit(new Dictionary<string, object> { { "t", "fatal" }, { "message", message } });
            Environment.Exit(3);
        }
    }

    internal static class SecurityHelper
    {
        public static string CurrentUserSid()
        {
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                if (identity.User == null) throw new BridgeFatalException("current token has no user SID", 0);
                return identity.User.Value;
            }
        }

        public static string SidToString(IntPtr sid)
        {
            IntPtr buffer;
            if (!Win32.ConvertSidToStringSidW(sid, out buffer))
                throw new BridgeFatalException("ConvertSidToStringSid failed", Marshal.GetLastWin32Error());
            try
            {
                return Marshal.PtrToStringUni(buffer);
            }
            finally
            {
                Win32.LocalFree(buffer);
            }
        }

        public static string GetTokenUserSid(IntPtr token)
        {
            uint length = 0;
            Win32.GetTokenInformation(token, Win32.TokenUser, IntPtr.Zero, 0, out length);
            if (length == 0) throw new BridgeFatalException("GetTokenInformation(TokenUser) size probe failed", Marshal.GetLastWin32Error());
            IntPtr buffer = Marshal.AllocHGlobal((int)length);
            try
            {
                uint returned;
                if (!Win32.GetTokenInformation(token, Win32.TokenUser, buffer, length, out returned))
                    throw new BridgeFatalException("GetTokenInformation(TokenUser) failed", Marshal.GetLastWin32Error());
                IntPtr sid = Marshal.ReadIntPtr(buffer, 0);
                return SidToString(sid);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static string GetProcessUserSid(IntPtr processHandle)
        {
            IntPtr token;
            if (!Win32.OpenProcessToken(processHandle, Win32.TOKEN_QUERY, out token))
                throw new BridgeFatalException("OpenProcessToken failed", Marshal.GetLastWin32Error());
            try
            {
                return GetTokenUserSid(token);
            }
            finally
            {
                Win32.CloseHandle(token);
            }
        }

        public static void VerifyParentUser(uint parentPid, string currentUserSid)
        {
            IntPtr handle = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION | Win32.SYNCHRONIZE, false, parentPid);
            if (handle == IntPtr.Zero)
                throw new BridgeFatalException("cannot open parent process " + parentPid, Marshal.GetLastWin32Error());
            try
            {
                string parentSid = GetProcessUserSid(handle);
                if (!string.Equals(parentSid, currentUserSid, StringComparison.OrdinalIgnoreCase))
                    throw new BridgeFatalException("parent token user " + parentSid + " does not match current user " + currentUserSid, 0);
            }
            finally
            {
                Win32.CloseHandle(handle);
            }
        }

        public static IntPtr BuildProtectedDescriptor(string userSid)
        {
            // O/G explicit so the readback owner is unambiguous. D:P protects the DACL from
            // inherited ACEs. Current user + SYSTEM full, NETWORK explicitly denied.
            string sddl = "O:" + userSid + "G:" + userSid + "D:P(D;;FA;;;NU)(A;;FA;;;" + userSid + ")(A;;FA;;;SY)";
            IntPtr descriptor;
            uint size;
            if (!Win32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, Win32.SDDL_REVISION_1, out descriptor, out size))
                throw new BridgeFatalException("building protected security descriptor failed", Marshal.GetLastWin32Error());
            return descriptor;
        }

        public static IntPtr GetDescriptor(IntPtr handle)
        {
            IntPtr owner;
            IntPtr group;
            IntPtr dacl;
            IntPtr sacl;
            IntPtr descriptor;
            uint result = Win32.GetSecurityInfo(handle, Win32.SE_KERNEL_OBJECT,
                Win32.OWNER_SECURITY_INFORMATION | Win32.GROUP_SECURITY_INFORMATION | Win32.DACL_SECURITY_INFORMATION,
                out owner, out group, out dacl, out sacl, out descriptor);
            if (result != 0)
                throw new BridgeFatalException("GetSecurityInfo failed on pipe handle", (int)result);
            return descriptor;
        }

        public static string DescriptorToSddl(IntPtr descriptor)
        {
            IntPtr text;
            uint length;
            if (!Win32.ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, Win32.SDDL_REVISION_1,
                Win32.OWNER_SECURITY_INFORMATION | Win32.GROUP_SECURITY_INFORMATION | Win32.DACL_SECURITY_INFORMATION,
                out text, out length))
                throw new BridgeFatalException("ConvertSecurityDescriptorToStringSecurityDescriptor failed", Marshal.GetLastWin32Error());
            try
            {
                return Marshal.PtrToStringUni(text);
            }
            finally
            {
                Win32.LocalFree(text);
            }
        }

        public static string ReadPipeSddl(IntPtr handle)
        {
            IntPtr descriptor = GetDescriptor(handle);
            try
            {
                return DescriptorToSddl(descriptor);
            }
            finally
            {
                Win32.LocalFree(descriptor);
            }
        }

        public static string OwnerFromSddl(string sddl)
        {
            int owner = sddl.IndexOf("O:", StringComparison.Ordinal);
            int group = sddl.IndexOf("G:", StringComparison.Ordinal);
            if (owner < 0 || group < 0 || group <= owner) return null;
            return sddl.Substring(owner + 2, group - owner - 2);
        }

        public static bool HasAce(string sddl, char aceType, string sid)
        {
            string needle = "(" + aceType + ";";
            int index = 0;
            while ((index = sddl.IndexOf(needle, index, StringComparison.Ordinal)) >= 0)
            {
                int end = sddl.IndexOf(')', index);
                if (end < 0) break;
                string ace = sddl.Substring(index, end - index + 1);
                if (ace.EndsWith(";;;" + sid + ")", StringComparison.OrdinalIgnoreCase)) return true;
                index = end;
            }
            return false;
        }

        public static bool IsDaclProtected(string sddl)
        {
            return sddl.IndexOf("D:P", StringComparison.Ordinal) >= 0;
        }

        public static string StructuralProblem(string sddl, string expectedUserSid)
        {
            try {
                var sd = new RawSecurityDescriptor(sddl);
                if (sd.Owner == null || sd.Owner.Value != expectedUserSid) return "unexpected owner";
                if ((sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
                    (sd.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 ||
                    sd.DiscretionaryAcl == null || sd.DiscretionaryAcl.Count != 3) return "unexpected DACL";
                string[] sids = { "S-1-5-2", expectedUserSid, "S-1-5-18" };
                for (int i = 0; i < 3; i++) {
                    var ace = sd.DiscretionaryAcl[i] as CommonAce;
                    if (ace == null || ace.IsCallback || ace.AceFlags != AceFlags.None ||
                        ace.AccessMask != (int)Win32.FILE_ALL_ACCESS || ace.SecurityIdentifier.Value != sids[i] ||
                        ace.AceQualifier != (i == 0 ? AceQualifier.AccessDenied : AceQualifier.AccessAllowed))
                        return "unexpected ACE order, type, rights or principal";
                }
                return null;
            } catch { return "invalid security descriptor"; }
        }

        public static IntPtr OpenCurrentImpersonationToken()
        {
            IntPtr processToken;
            if (!Win32.OpenProcessToken(Win32.GetCurrentProcess(), Win32.TOKEN_DUPLICATE | Win32.TOKEN_QUERY, out processToken))
                throw new BridgeFatalException("OpenProcessToken(current) failed", Marshal.GetLastWin32Error());
            try
            {
                return DuplicateAsImpersonation(processToken);
            }
            finally
            {
                Win32.CloseHandle(processToken);
            }
        }

        public static IntPtr DuplicateAsImpersonation(IntPtr primaryToken)
        {
            IntPtr impersonation;
            if (!Win32.DuplicateTokenEx(primaryToken, Win32.TOKEN_QUERY, IntPtr.Zero,
                Win32.SecurityImpersonation, Win32.TokenImpersonation, out impersonation))
                throw new BridgeFatalException("DuplicateTokenEx failed", Marshal.GetLastWin32Error());
            return impersonation;
        }

        /// <summary>Restricted token with the user SID disabled (deny-only): the user allow ACE is ignored.</summary>
        public static IntPtr OpenRestrictedImpersonationToken(string userSid)
        {
            IntPtr processToken;
            if (!Win32.OpenProcessToken(Win32.GetCurrentProcess(), Win32.TOKEN_DUPLICATE | Win32.TOKEN_QUERY, out processToken))
                throw new BridgeFatalException("OpenProcessToken(current) failed", Marshal.GetLastWin32Error());
            IntPtr sid = IntPtr.Zero;
            IntPtr disabledArray = IntPtr.Zero;
            try
            {
                if (!Win32.ConvertStringSidToSidW(userSid, out sid))
                    throw new BridgeFatalException("ConvertStringSidToSid failed", Marshal.GetLastWin32Error());
                int entrySize = Marshal.SizeOf(typeof(Win32.SID_AND_ATTRIBUTES));
                disabledArray = Marshal.AllocHGlobal(entrySize);
                var entry = new Win32.SID_AND_ATTRIBUTES();
                entry.Sid = sid;
                entry.Attributes = 0;
                Marshal.StructureToPtr(entry, disabledArray, false);
                IntPtr restricted;
                if (!Win32.CreateRestrictedToken(processToken, 0, 1, disabledArray, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
                    throw new BridgeFatalException("CreateRestrictedToken failed", Marshal.GetLastWin32Error());
                try
                {
                    return DuplicateAsImpersonation(restricted);
                }
                finally
                {
                    Win32.CloseHandle(restricted);
                }
            }
            finally
            {
                if (disabledArray != IntPtr.Zero) Marshal.FreeHGlobal(disabledArray);
                if (sid != IntPtr.Zero) Win32.LocalFree(sid);
                Win32.CloseHandle(processToken);
            }
        }

        public static bool AccessCheckDescriptor(IntPtr descriptor, IntPtr impersonationToken)
        {
            uint granted;
            int error;
            return AccessCheckDescriptor(descriptor, impersonationToken, out granted, out error);
        }

        public static bool AccessCheckDescriptor(IntPtr descriptor, IntPtr impersonationToken, out uint granted, out int error)
        {
            var mapping = new Win32.GENERIC_MAPPING();
            mapping.GenericRead = Win32.FILE_GENERIC_READ;
            mapping.GenericWrite = Win32.FILE_GENERIC_WRITE;
            mapping.GenericExecute = Win32.FILE_GENERIC_EXECUTE;
            mapping.GenericAll = Win32.FILE_ALL_ACCESS;
            uint privilegeLength = 0;
            bool status;
            Win32.AccessCheck(descriptor, impersonationToken, Win32.FILE_GENERIC_READ | Win32.FILE_GENERIC_WRITE, ref mapping,
                IntPtr.Zero, ref privilegeLength, out granted, out status);
            if (privilegeLength == 0) privilegeLength = 1024;
            IntPtr privileges = Marshal.AllocHGlobal((int)privilegeLength);
            try
            {
                bool ok = Win32.AccessCheck(descriptor, impersonationToken, Win32.FILE_GENERIC_READ | Win32.FILE_GENERIC_WRITE,
                    ref mapping, privileges, ref privilegeLength, out granted, out status);
                error = ok ? 0 : Marshal.GetLastWin32Error();
                return ok && status;
            }
            finally
            {
                Marshal.FreeHGlobal(privileges);
            }
        }
    }

    internal sealed class PipeWrite
    {
        public byte[] Bytes;
        public int Seq;
    }

    internal sealed class PipeConnection
    {
        private readonly int _id;
        private readonly IntPtr _handle;
        private readonly FileStream _stream;
        private readonly BlockingCollection<PipeWrite> _queue;
        private readonly ServerMode _server;
        private int _closed;

        public int Id { get { return _id; } }

        public PipeConnection(int id, IntPtr handle, int queueCapacity, ServerMode server)
        {
            _id = id;
            _handle = handle;
            _stream = new FileStream(new SafeFileHandle(handle, false), FileAccess.ReadWrite, 65536, true);
            _server = server;
            _queue = new BlockingCollection<PipeWrite>(boundedCapacity: queueCapacity);
        }

        public void Start()
        {
            Thread reader = new Thread(ReadLoop);
            reader.IsBackground = true;
            reader.Name = "pipe-read-" + _id;
            reader.Start();
            Thread writer = new Thread(WriteLoop);
            writer.IsBackground = true;
            writer.Name = "pipe-write-" + _id;
            writer.Start();
        }

        public bool Enqueue(byte[] payload, int seq)
        {
            try
            {
                return _queue.TryAdd(new PipeWrite { Bytes = payload, Seq = seq }, _server.WriteTimeoutMs);
            }
            catch (InvalidOperationException)
            {
                return false;
            }
        }

        public void Close(string reason)
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0) return;
            try { _queue.CompleteAdding(); } catch { }
            try { Win32.CancelIoEx(_handle, IntPtr.Zero); _stream.Dispose(); } catch { }
            try { Win32.DisconnectNamedPipe(_handle); } catch { }
            Win32.CloseHandle(_handle);
            _server.OnConnectionClosed(_id, reason);
        }

        private void ReadLoop()
        {
            byte[] buffer = new byte[64 * 1024];
            try
            {
                while (true)
                {
                    int read = _stream.ReadAsync(buffer, 0, buffer.Length).GetAwaiter().GetResult();
                    if (read == 0) break;
                    byte[] chunk = new byte[read];
                    Buffer.BlockCopy(buffer, 0, chunk, 0, (int)read);
                    Frames.Emit(Frames.Data(_id, chunk));
                }
            }
            catch (Exception ex)
            {
                Frames.Diag("connection " + _id + " read error: " + ex.Message);
            }
            Close("pipe-eof");
        }

        private void WriteLoop()
        {
            try
            {
                foreach (PipeWrite chunk in _queue.GetConsumingEnumerable())
                {
                    if (!WriteAll(chunk.Bytes))
                    {
                        Close("pipe-write-failed");
                        return;
                    }
                    Frames.Ack(_id, chunk.Seq);
                }
            }
            catch (Exception ex)
            {
                Frames.Diag("connection " + _id + " write error: " + ex.Message);
                Close("pipe-write-error");
            }
        }

        private bool WriteAll(byte[] chunk)
        {
            using (var deadline = new Timer(delegate { Environment.Exit(5); }, null, 5000, Timeout.Infinite))
            {
                _stream.WriteAsync(chunk, 0, chunk.Length).GetAwaiter().GetResult();
                _stream.FlushAsync().GetAwaiter().GetResult();
                return true;
            }
        }
    }

    internal sealed class ServerMode
    {
        private readonly string _pipeName;
        private readonly string _userSid;
        private readonly uint _parentPid;
        private readonly int _maxConnections;
        private readonly int _queueCapacity;
        private readonly object _connectionLock = new object();
        private readonly Dictionary<int, PipeConnection> _connections = new Dictionary<int, PipeConnection>();
        private int _nextId = 1;
        private bool _shutdown;
        private int _shuttingDown;

        public Action<string> Ready;
        public int WriteTimeoutMs { get; private set; }

        public ServerMode(string pipeName, uint parentPid, string userSid, int maxConnections, int queueCapacity,
            int writeTimeoutMs)
        {
            _pipeName = pipeName;
            _userSid = userSid;
            _parentPid = parentPid;
            _maxConnections = maxConnections;
            _queueCapacity = queueCapacity;
            WriteTimeoutMs = writeTimeoutMs;
            SecurityHelper.VerifyParentUser(parentPid, userSid);
        }

        public int Run()
        {
            IntPtr first = CreateInstance(true);
            if (Ready != null) Ready(SecurityHelper.ReadPipeSddl(first));
            StartParentMonitor();
            Thread stdinThread = new Thread(StdinLoop);
            stdinThread.IsBackground = true;
            stdinThread.Name = "stdin";
            stdinThread.Start();
            AcceptLoop(first);
            return 0;
        }

        private void StdinLoop()
        {
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 16 * 1024))
                {
                    string line;
                    while ((line = Frames.ReadLine(reader)) != null)
                    {
                        if (_shutdown) return;
                        if (line.Length == 0) continue;
                        HandleFrame(line);
                    }
                }
            }
            catch (Exception ex)
            {
                Frames.Fatal("stdin error: " + ex.Message);
            }
            Shutdown(0, "stdin-eof");
        }

        private void HandleFrame(string line)
        {
            Dictionary<string, object> frame;
            try
            {
                frame = Frames.Parse(line);
            }
            catch (Exception ex)
            {
                Frames.Fatal("bad internal frame: " + ex.Message);
                Shutdown(4, "bad-frame");
                return;
            }
            string type = Frames.GetString(frame, "t");
            if (type == "shutdown")
            {
                Shutdown(0, "shutdown-frame");
                return;
            }
            if (type != "data" && type != "close")
            {
                Frames.Fatal("unexpected internal frame type: " + type);
                Shutdown(4, "bad-frame");
                return;
            }
            int id;
            try
            {
                id = Frames.GetInt(frame, "id");
            }
            catch (Exception ex)
            {
                Frames.Fatal(ex.Message);
                return;
            }
            PipeConnection connection;
            lock (_connectionLock)
            {
                _connections.TryGetValue(id, out connection);
            }
            if (connection == null) return;
            if (type == "close")
            {
                connection.Close("node-close");
                return;
            }
            string payload = Frames.GetString(frame, "b");
            if (payload == null)
            {
                Frames.Fatal("data frame missing payload");
                return;
            }
            byte[] bytes;
            try
            {
                bytes = Convert.FromBase64String(payload);
            }
            catch (FormatException)
            {
                Frames.Fatal("data frame payload is not valid base64");
                return;
            }
            if (bytes.Length > 64 * 1024) throw new BridgeFatalException("data chunk too large", 0);
            int seq = frame.ContainsKey("seq") ? Frames.GetInt(frame, "seq") : 0;
            if (!connection.Enqueue(bytes, seq))
            {
                Frames.Diag("connection " + id + " write queue overflow; closing");
                connection.Close("write-backpressure");
            }
        }

        private IntPtr CreateInstance(bool first)
        {
            IntPtr descriptor = SecurityHelper.BuildProtectedDescriptor(_userSid);
            IntPtr handle;
                var attributes = new Win32.SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(Win32.SECURITY_ATTRIBUTES));
                attributes.lpSecurityDescriptor = descriptor;
                attributes.bInheritHandle = false;
                handle = Win32.CreateNamedPipeWithSdW(_pipeName, OpenMode(first), PipeMode(), Win32.PIPE_UNLIMITED_INSTANCES,
                    64 * 1024, 64 * 1024, 0, ref attributes);
            int error = Marshal.GetLastWin32Error();
            if (descriptor != IntPtr.Zero) Win32.LocalFree(descriptor);
            if (handle == Win32.INVALID_HANDLE_VALUE)
            {
                throw new BridgeFatalException("CreateNamedPipe failed for " + _pipeName +
                    " (another service may already own this name)", error);
            }
            string sddl = SecurityHelper.ReadPipeSddl(handle);
                string problem = SecurityHelper.StructuralProblem(sddl, _userSid);
                if (problem != null)
                {
                    Win32.CloseHandle(handle);
                    throw new BridgeFatalException("created pipe ACL verification failed: " + problem, 0);
                }
            return handle;
        }

        private static uint OpenMode(bool first)
        {
            uint mode = Win32.PIPE_ACCESS_DUPLEX | Win32.FILE_FLAG_OVERLAPPED;
            if (first) mode |= Win32.FILE_FLAG_FIRST_PIPE_INSTANCE;
            return mode;
        }

        private static uint PipeMode()
        {
            return Win32.PIPE_TYPE_BYTE | Win32.PIPE_READMODE_BYTE | Win32.PIPE_WAIT | Win32.PIPE_REJECT_REMOTE_CLIENTS;
        }

        private void AcceptLoop(IntPtr listener)
        {
            try
            {
                while (!_shutdown)
                {
                    lock (_connectionLock)
                    {
                        while (_connections.Count >= _maxConnections && !_shutdown) Monitor.Wait(_connectionLock);
                    }
                    if (_shutdown) break;

                    bool connected = Win32.Accept(listener);
                    int error = Marshal.GetLastWin32Error();
                    if (!connected && error != Win32.ERROR_PIPE_CONNECTED)
                    {
                        if (_shutdown) break;
                        throw new BridgeFatalException("ConnectNamedPipe failed", error);
                    }

                    var connection = new PipeConnection(_nextId++, listener, _queueCapacity, this);
                    listener = CreateInstance(false);
                    lock (_connectionLock)
                    {
                        _connections[connection.Id] = connection;
                    }
                    Frames.Emit(Frames.Conn(connection.Id));
                    connection.Start();
                }
            }
            catch (BridgeFatalException ex)
            {
                Frames.Fatal(ex.Message);
                Shutdown(3, "accept-fatal");
            }
            catch (Exception ex)
            {
                Frames.Fatal("accept loop error: " + ex.Message);
                Shutdown(3, "accept-fatal");
            }
            finally
            {
                if (listener != IntPtr.Zero) Win32.CloseHandle(listener);
            }
        }

        public void OnConnectionClosed(int id, string reason)
        {
            lock (_connectionLock)
            {
                _connections.Remove(id);
                Monitor.PulseAll(_connectionLock);
            }
            Frames.Emit(Frames.Close(id));
            Frames.Diag("connection " + id + " closed (" + reason + ")");
        }

        private void StartParentMonitor()
        {
            // The parent handle was verified in the constructor; wait for its exit so a dead
            // daemon never leaves a serving pipe behind.
            IntPtr parent = Win32.OpenProcess(Win32.SYNCHRONIZE, false, _parentPid);
            if (parent == IntPtr.Zero) throw new BridgeFatalException("cannot monitor parent", Marshal.GetLastWin32Error());
            Thread monitor = new Thread(delegate()
            {
                Win32.WaitForSingleObject(parent, Win32.INFINITE);
                Shutdown(0, "parent-exit");
            });
            monitor.IsBackground = true;
            monitor.Name = "parent-monitor";
            monitor.Start();
        }

        public void Shutdown(int exitCode, string reason)
        {
            if (Interlocked.Exchange(ref _shuttingDown, 1) != 0) return;
            _shutdown = true;
            lock (_connectionLock)
            {
                Monitor.PulseAll(_connectionLock);
                foreach (PipeConnection connection in new List<PipeConnection>(_connections.Values))
                {
                    try { connection.Close("shutdown"); } catch { }
                }
                _connections.Clear();
            }
            Frames.Diag("shutting down: " + reason);
            try { Frames.Emit(new Dictionary<string, object> { { "t", "stopped" }, { "reason", reason } }); } catch { }
            Environment.Exit(exitCode);
        }
    }

    internal sealed class ClientMode
    {
        private readonly string _userSid;
        private readonly string _pipeName;
        private readonly IntPtr _pipe;
        private readonly FileStream _stream;
        private bool _shutdown;

        public ClientMode(string pipeName, uint parentPid, uint connectTimeoutMs)
        {
            _pipeName = pipeName;
            _userSid = SecurityHelper.CurrentUserSid();
            SecurityHelper.VerifyParentUser(parentPid, _userSid);
            _pipe = Connect(connectTimeoutMs);
            _stream = new FileStream(new SafeFileHandle(_pipe, false), FileAccess.ReadWrite, 65536, true);
            VerifyServer();
        }

        private IntPtr Connect(uint timeoutMs)
        {
            int deadline = Environment.TickCount + (int)timeoutMs;
            while (true)
            {
                IntPtr handle = Win32.CreateFileW(_pipeName, Win32.GENERIC_READ | Win32.GENERIC_WRITE, 0, IntPtr.Zero,
                    Win32.OPEN_EXISTING, Win32.FILE_FLAG_OVERLAPPED, IntPtr.Zero);
                if (handle != Win32.INVALID_HANDLE_VALUE) return handle;
                int error = Marshal.GetLastWin32Error();
                int remaining = deadline - Environment.TickCount;
                if (error == Win32.ERROR_PIPE_BUSY)
                {
                    if (remaining <= 0 || !Win32.WaitNamedPipeW(_pipeName, (uint)remaining)) break;
                    continue;
                }
                if (error == Win32.ERROR_FILE_NOT_FOUND)
                {
                    if (remaining <= 0) break;
                    Thread.Sleep(50);
                    continue;
                }
                throw new BridgeFatalException("cannot open pipe " + _pipeName, error);
            }
            throw new BridgeFatalException("pipe " + _pipeName + " is not available within timeout", 0);
        }

        private void VerifyServer()
        {
            uint serverPid;
            if (!Win32.GetNamedPipeServerProcessId(_pipe, out serverPid))
                throw new BridgeFatalException("GetNamedPipeServerProcessId failed", Marshal.GetLastWin32Error());
            IntPtr process = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, serverPid);
            if (process == IntPtr.Zero)
                throw new BridgeFatalException("cannot open pipe server process " + serverPid, Marshal.GetLastWin32Error());
            string serverSid;
            try
            {
                serverSid = SecurityHelper.GetProcessUserSid(process);
            }
            finally
            {
                Win32.CloseHandle(process);
            }
            if (!string.Equals(serverSid, _userSid, StringComparison.OrdinalIgnoreCase))
                throw new BridgeFatalException("pipe server token user " + serverSid + " is not current user " + _userSid, 0);

            IntPtr descriptor = SecurityHelper.GetDescriptor(_pipe);
            string sddl;
            try
            {
                sddl = SecurityHelper.DescriptorToSddl(descriptor);
                string problem = SecurityHelper.StructuralProblem(sddl, _userSid);
                if (problem != null)
                    throw new BridgeFatalException("pipe ACL verification failed: " + problem, 0);
            }
            finally
            {
                Win32.LocalFree(descriptor);
            }
            Frames.Emit(new Dictionary<string, object>
            {
                { "t", "ready" },
                { "role", "client" },
                { "pipe", _pipeName },
                { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                { "userSid", _userSid },
                { "serverPid", serverPid },
                { "serverUserSid", serverSid },
                { "dacl", sddl },
                { "verified", true },
            });
        }

        public int Run()
        {
            Thread stdinThread = new Thread(StdinLoop);
            stdinThread.IsBackground = true;
            stdinThread.Name = "stdin";
            stdinThread.Start();
            Thread parentThread = new Thread(ParentLoop);
            parentThread.IsBackground = true;
            parentThread.Name = "parent-monitor";
            parentThread.Start();
            PipeLoop();
            return 0;
        }

        private void StdinLoop()
        {
            try
            {
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false, 16 * 1024))
                {
                    string line;
                    while ((line = Frames.ReadLine(reader)) != null)
                    {
                        if (_shutdown) return;
                        if (line.Length == 0) continue;
                        Dictionary<string, object> frame;
                        try { frame = Frames.Parse(line); }
                        catch (Exception ex)
                        {
                            Frames.Fatal("bad internal frame: " + ex.Message);
                            Shutdown(4);
                            return;
                        }
                        string type = Frames.GetString(frame, "t");
                        if (type == "shutdown" || type == "close")
                        {
                            Shutdown(0);
                            return;
                        }
                        if (type != "data") continue;
                        string payload = Frames.GetString(frame, "b");
                        if (payload == null) continue;
                        byte[] bytes;
                        try { bytes = Convert.FromBase64String(payload); }
                        catch (FormatException)
                        {
                            Frames.Fatal("data frame payload is not valid base64");
                            continue;
                        }
                        if (!WriteAll(bytes))
                        {
                            Shutdown(5);
                            return;
                        }
                        Frames.Ack(1, frame.ContainsKey("seq") ? Frames.GetInt(frame, "seq") : 0);
                    }
                }
            }
            catch (Exception ex)
            {
                Frames.Fatal("stdin error: " + ex.Message);
            }
            Shutdown(0);
        }

        private bool WriteAll(byte[] chunk)
        {
            using (var deadline = new Timer(delegate { Environment.Exit(5); }, null, 5000, Timeout.Infinite))
            {
                if (chunk.Length > 64 * 1024) throw new BridgeFatalException("data chunk too large", 0);
                _stream.WriteAsync(chunk, 0, chunk.Length).GetAwaiter().GetResult();
                _stream.FlushAsync().GetAwaiter().GetResult();
                return true;
            }
        }

        private void PipeLoop()
        {
            byte[] buffer = new byte[64 * 1024];
            try
            {
                while (true)
                {
                    int read = _stream.ReadAsync(buffer, 0, buffer.Length).GetAwaiter().GetResult();
                    if (read == 0) break;
                    byte[] chunk = new byte[read];
                    Buffer.BlockCopy(buffer, 0, chunk, 0, (int)read);
                    Frames.Emit(Frames.Data(1, chunk));
                }
            }
            catch (Exception ex)
            {
                Frames.Diag("pipe read error: " + ex.Message);
            }
            Frames.Emit(Frames.Close(1));
            Shutdown(0);
        }

        private void ParentLoop()
        {
            IntPtr parent = Win32.OpenProcess(Win32.SYNCHRONIZE, false, Program.ParentPid);
            if (parent == IntPtr.Zero) { Shutdown(3); return; }
            Win32.WaitForSingleObject(parent, Win32.INFINITE);
            Shutdown(0);
        }

        private void Shutdown(int exitCode)
        {
            _shutdown = true;
            try { Win32.CancelIoEx(_pipe, IntPtr.Zero); _stream.Dispose(); } catch { }
            try { Win32.DisconnectNamedPipe(_pipe); } catch { }
            Win32.CloseHandle(_pipe);
            Environment.Exit(exitCode);
        }
    }

    internal static class Program
    {
        public static uint ParentPid;

        private static void Main(string[] args)
        {
            Frames.Initialize();
            try
            {
                var options = BridgeOptions.Parse(args);
                if (options.ShowHelp)
                {
                    Console.WriteLine(BridgeOptions.Usage);
                    return;
                }
                switch (options.Mode)
                {
                    case "server":
                        RunServer(options);
                        break;
                    case "client":
                        ParentPid = options.ParentPid;
                        RunClient(options);
                        break;
                    case "acltest":
                        Environment.Exit(AclTest.Run(options.PipeName));
                        break;
                    default:
                        Console.Error.WriteLine("unknown mode: " + options.Mode);
                        Environment.Exit(2);
                        break;
                }
            }
            catch (BridgeFatalException ex)
            {
                Frames.Fatal(ex.Message + (ex.Win32Error != 0 ? " (win32=" + ex.Win32Error + ")" : ""));
                Environment.Exit(3);
            }
            catch (Exception ex)
            {
                Frames.Fatal("unexpected failure: " + ex);
                Environment.Exit(3);
            }
        }

        private static void RunServer(BridgeOptions options)
        {
            string userSid = SecurityHelper.CurrentUserSid();
            var server = new ServerMode(options.PipeName, options.ParentPid, userSid, options.MaxConnections,
                options.QueueCapacity, options.WriteTimeoutMs);
            // CreateInstance happens inside Run; emit ready only after the first descriptor is verified.
            server.Ready = delegate(string sddl)
            {
                Frames.Emit(new Dictionary<string, object>
                {
                    { "t", "ready" },
                    { "role", "server" },
                    { "pipe", options.PipeName },
                    { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                    { "parentPid", (int)options.ParentPid },
                    { "userSid", userSid },
                    { "dacl", sddl },
                    { "rejectRemote", true },
                    { "maxConnections", options.MaxConnections },
                    { "verified", true },
                });
            };
            int code = server.Run();
            Environment.Exit(code);
        }

        private static void RunClient(BridgeOptions options)
        {
            var client = new ClientMode(options.PipeName, options.ParentPid, options.ConnectTimeoutMs);
            Environment.Exit(client.Run());
        }
    }

    /// <summary>Read-back + AccessCheck test used by scripts/test-native-windows.mjs.</summary>
    internal static class AclTest
    {
        public static int Run(string pipeName)
        {
            if (string.IsNullOrEmpty(pipeName))
            {
                Frames.Fatal("acltest requires --pipe <name>");
                return 2;
            }
            string userSid = SecurityHelper.CurrentUserSid();
            IntPtr pipe = Win32.CreateFileW(pipeName, Win32.GENERIC_READ, 0, IntPtr.Zero, Win32.OPEN_EXISTING, 0, IntPtr.Zero);
            if (pipe == Win32.INVALID_HANDLE_VALUE)
            {
                Frames.Fatal("acltest cannot open " + pipeName + " (win32=" + Marshal.GetLastWin32Error() + ")");
                return 3;
            }
            try
            {
                IntPtr descriptor = SecurityHelper.GetDescriptor(pipe);
                try
                {
                    string sddl = SecurityHelper.DescriptorToSddl(descriptor);
                    string problem = SecurityHelper.StructuralProblem(sddl, userSid);
                    uint currentGranted;
                    int currentError;
                    bool currentAllowed;
                    IntPtr currentToken = SecurityHelper.OpenCurrentImpersonationToken();
                    try { currentAllowed = SecurityHelper.AccessCheckDescriptor(descriptor, currentToken, out currentGranted, out currentError); }
                    finally { Win32.CloseHandle(currentToken); }
                    uint restrictedGranted;
                    int restrictedError;
                    bool restrictedAllowed;
                    IntPtr restrictedToken = SecurityHelper.OpenRestrictedImpersonationToken(userSid);
                    try { restrictedAllowed = SecurityHelper.AccessCheckDescriptor(descriptor, restrictedToken, out restrictedGranted, out restrictedError); }
                    finally { Win32.CloseHandle(restrictedToken); }
                    bool restrictedDenied = restrictedError == 0 && !restrictedAllowed;
                    bool ok = problem == null && currentAllowed && restrictedDenied;
                    Frames.Emit(new Dictionary<string, object>
                    {
                        { "t", "acltest" },
                        { "pipe", pipeName },
                        { "userSid", userSid },
                        { "ownerSid", SecurityHelper.OwnerFromSddl(sddl) },
                        { "dacl", sddl },
                        { "structural", problem == null ? "ok" : problem },
                        { "currentTokenGranted", currentAllowed },
                        { "currentGrantedMask", currentGranted },
                        { "currentError", currentError },
                        { "restrictedTokenDenied", restrictedDenied },
                        { "restrictedAllowed", restrictedAllowed },
                        { "restrictedError", restrictedError },
                        { "ok", ok },
                    });
                    return ok ? 0 : 1;
                }
                finally
                {
                    Win32.LocalFree(descriptor);
                }
            }
            finally
            {
                Win32.CloseHandle(pipe);
            }
        }
    }

    internal sealed class BridgeOptions
    {
        public const string Usage =
            "usage:\n" +
            "  CwPipeBridge server --pipe <name> --parent <pid> [--max-connections N] [--write-queue N]\n" +
            "                     [--write-timeout-ms N]\n" +
            "  CwPipeBridge client --pipe <name> --parent <pid> [--connect-timeout-ms N]\n" +
            "  CwPipeBridge acltest --pipe <name>\n";

        public string Mode;
        public string PipeName;
        public uint ParentPid;
        public uint ConnectTimeoutMs = 3000;
        public int MaxConnections = 32;
        public int QueueCapacity = 16;
        public int WriteTimeoutMs = 5000;
        public bool ShowHelp;

        public static BridgeOptions Parse(string[] args)
        {
            var options = new BridgeOptions();
            if (args.Length == 0)
            {
                options.ShowHelp = true;
                return options;
            }
            options.Mode = args[0];
            for (int i = 1; i < args.Length; i++)
            {
                string argument = args[i];
                string value = i + 1 < args.Length ? args[i + 1] : null;
                switch (argument)
                {
                    case "--help":
                    case "-h":
                        options.ShowHelp = true;
                        return options;
                    case "--pipe":
                        options.PipeName = RequireValue(argument, value);
                        i++;
                        break;
                    case "--parent":
                        options.ParentPid = uint.Parse(RequireValue(argument, value), CultureInfo.InvariantCulture);
                        i++;
                        break;
                    case "--max-connections":
                        options.MaxConnections = int.Parse(RequireValue(argument, value), CultureInfo.InvariantCulture);
                        i++;
                        break;
                    case "--write-queue":
                        options.QueueCapacity = int.Parse(RequireValue(argument, value), CultureInfo.InvariantCulture);
                        i++;
                        break;
                    case "--write-timeout-ms":
                        options.WriteTimeoutMs = int.Parse(RequireValue(argument, value), CultureInfo.InvariantCulture);
                        i++;
                        break;
                    case "--connect-timeout-ms":
                        options.ConnectTimeoutMs = uint.Parse(RequireValue(argument, value), CultureInfo.InvariantCulture);
                        i++;
                        break;
                    default:
                        throw new BridgeFatalException("unknown argument: " + argument, 0);
                }
            }
            if (options.Mode != "acltest" && string.IsNullOrEmpty(options.PipeName))
                throw new BridgeFatalException("--pipe is required", 0);
            if ((options.Mode == "server" || options.Mode == "client") && options.ParentPid == 0)
                throw new BridgeFatalException("--parent is required", 0);
            if (options.MaxConnections < 1 || options.MaxConnections > 32 || options.QueueCapacity < 1 ||
                options.QueueCapacity > 32 || options.WriteTimeoutMs < 1 || options.WriteTimeoutMs > 5000 ||
                options.ConnectTimeoutMs < 1 || options.ConnectTimeoutMs > 15000)
                throw new BridgeFatalException("bridge limits out of range", 0);
            return options;
        }

        private static string RequireValue(string argument, string value)
        {
            if (value == null) throw new BridgeFatalException(argument + " requires a value", 0);
            return value;
        }
    }
}
