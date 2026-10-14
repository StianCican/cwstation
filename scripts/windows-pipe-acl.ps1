# Read-only Win32 query of a Windows named pipe's security descriptor (DACL).
#
# Purpose: P1-002 requires measuring the *actual* access boundary of the named
# pipe that the Node daemon creates. Node/libuv creates the pipe with
# lpSecurityAttributes = NULL, i.e. the process default DACL. This script opens
# an existing pipe with READ_CONTROL only (no read/write of pipe data) and
# converts its security descriptor to SDDL. It never modifies the pipe ACL and
# never sends or receives pipe payload bytes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-pipe-acl.ps1 -PipeName cwstation-...
#
# Output: one line of JSON with the pipe path, requested access and SDDL.

param(
  [Parameter(Mandatory = $true)][string]$PipeName
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class PipeAclProbe
{
    const uint READ_CONTROL = 0x00020000;
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint OPEN_EXISTING = 3;
    const int SE_KERNEL_OBJECT = 6;
    const uint OWNER_SECURITY_INFORMATION = 0x00000001;
    const uint GROUP_SECURITY_INFORMATION = 0x00000002;
    const uint DACL_SECURITY_INFORMATION = 0x00000004;
    const uint SDDL_REVISION_1 = 1;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint GetSecurityInfo(IntPtr handle, int ObjectType, uint SecurityInfo,
        out IntPtr ppsidOwner, out IntPtr ppsidGroup, out IntPtr ppDacl, out IntPtr ppSacl,
        out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev,
        uint secInfo, out IntPtr str, out uint len);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr LocalFree(IntPtr hMem);

    public static string GetSddl(string pipePath)
    {
        IntPtr h = CreateFileW(pipePath, READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (h == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFileW(READ_CONTROL) failed for " + pipePath);
        try
        {
            IntPtr owner, group, dacl, sacl, sd;
            uint rc = GetSecurityInfo(h, SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                out owner, out group, out dacl, out sacl, out sd);
            if (rc != 0) throw new Win32Exception((int)rc, "GetSecurityInfo failed");
            try
            {
                IntPtr str;
                uint len;
                if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, SDDL_REVISION_1,
                    OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    out str, out len))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSecurityDescriptorToStringSecurityDescriptorW failed");
                try { return Marshal.PtrToStringUni(str); }
                finally { LocalFree(str); }
            }
            finally { LocalFree(sd); }
        }
        finally { CloseHandle(h); }
    }
}
"@

$path = "\\.\pipe\$PipeName"
$sddl = [PipeAclProbe]::GetSddl($path)
[ordered]@{
  pipe = $path
  requestedAccess = "READ_CONTROL"
  sddl = $sddl
} | ConvertTo-Json -Compress
