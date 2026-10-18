param(
  [Parameter(Mandatory=$true)][string]$Path,
  [switch]$ProvisionLeaf
)
$ErrorActionPreference = 'Stop'
function Get-Sid([object]$Identity) {
  if ($Identity -is [string]) { $Identity = [Security.Principal.NTAccount]::new($Identity) }
  if ($Identity -is [Security.Principal.SecurityIdentifier]) { return $Identity.Value }
  return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value
}
function Assert-NoReparseAncestors([string]$FullPath) {
  $volume = [IO.Path]::GetPathRoot($FullPath)
  if ([string]::IsNullOrWhiteSpace($volume)) { throw 'invalid-root' }
  $current = $volume
  $relative = $FullPath.Substring($volume.Length)
  foreach ($part in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-ancestor' }
      if (-not $item.PSIsContainer) { throw 'non-directory-ancestor' }
    } else {
      [void][IO.Directory]::CreateDirectory($current)
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'created-reparsepoint' }
    }
  }
}
function Read-PrivateAcl([string]$Target, [string]$CurrentSid, [bool]$RequireProtected) {
  $item = Get-Item -LiteralPath $Target -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unsafe-directory' }
  $acl = Get-Acl -LiteralPath $Target
  $ownerSid = Get-Sid $acl.Owner
  if ($ownerSid -ne $CurrentSid) { throw 'wrong-owner' }
  if ($RequireProtected -and -not $acl.AreAccessRulesProtected) { throw 'unprotected-dacl' }
  $hasFullControl = $false
  foreach ($rule in $acl.Access) {
    $ruleSid = Get-Sid $rule.IdentityReference
    $full = (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
    if ($ruleSid -ne $CurrentSid -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not $full) { throw 'unsafe-ace' }
    $hasFullControl = $true
  }
  if (-not $hasFullControl) { throw 'missing-user-full-control' }
  return $acl
}
try {
  $fullPath = [IO.Path]::GetFullPath($Path)
  Assert-NoReparseAncestors $fullPath
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $sid = $me.Value
  $leafItem = Get-Item -LiteralPath $fullPath -Force
  if (-not $leafItem.PSIsContainer -or (($leafItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'unsafe-leaf' }
  $acl = Get-Acl -LiteralPath $fullPath
  $ownerSid = Get-Sid $acl.Owner
  if ($ownerSid -ne $sid) { throw 'wrong-owner' }
  # Audit all pre-existing descendants before changing the designated leaf DACL.
  # Walk manually: never recurse through a reparse point. Existing children/files are never rewritten.
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($fullPath)
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    foreach ($childPath in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $child = Get-Item -LiteralPath $childPath -Force
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-descendant' }
      $childAcl = Get-Acl -LiteralPath $childPath
      if ((Get-Sid $childAcl.Owner) -ne $sid) { throw 'wrong-descendant-owner' }
      $found = $false
      foreach ($rule in $childAcl.Access) {
        $ruleSid = Get-Sid $rule.IdentityReference
        $full = (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
        if ($ruleSid -ne $sid -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not $full) { throw 'unsafe-descendant-ace' }
        $found = $true
      }
      if (-not $found) { throw 'missing-descendant-user-full-control' }
      if ($child.PSIsContainer) { $stack.Push($childPath) }
    }
  }
  if ($ProvisionLeaf) {
    # Only normalize inherited leaf permissions. Never erase explicit/protected policy from an existing tree.
    foreach ($existingRule in $acl.Access) {
      if (-not $existingRule.IsInherited) {
        $existingSid = Get-Sid $existingRule.IdentityReference
        $existingFull = (($existingRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)
        if ($existingSid -ne $sid -or $existingRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or -not $existingFull) { throw 'unsafe-explicit-leaf-ace' }
      }
    }
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($oldRule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($oldRule) }
    $userRule = [Security.AccessControl.FileSystemAccessRule]::new($me, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($userRule)
    Set-Acl -LiteralPath $fullPath -AclObject $acl
  }
  $readback = Read-PrivateAcl $fullPath $sid $true
  $userAce = $false
  foreach ($rule in $readback.Access) { if ((Get-Sid $rule.IdentityReference) -eq $sid -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl)) { $userAce = $true } }
  [pscustomobject]@{ ownerSid=(Get-Sid $readback.Owner); currentSid=$sid; daclProtected=$readback.AreAccessRulesProtected; reparsePoint=(($leafItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0); unexpectedAccess=$false; currentUserFullControl=$userAce } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
