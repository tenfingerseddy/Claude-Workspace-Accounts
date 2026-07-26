[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ClaudeBinary,

    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArguments
)

$ErrorActionPreference = "Stop"
$GuardExitCode = 78
$SupportRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ClaudeAccountGuard"
} else {
    Join-Path $env:USERPROFILE ".claude-account-guard"
}
$RegistryPath = Join-Path $SupportRoot "registry.json"
$WrapperHealthPath = Join-Path $SupportRoot "wrapper-health.json"

function Write-GuardHealth {
    param(
        [string]$Category,
        [int]$ExitCode
    )
    try {
        [System.IO.Directory]::CreateDirectory($SupportRoot) | Out-Null
        $temporary = "$WrapperHealthPath.$PID.$([Guid]::NewGuid().ToString('n')).tmp"
        [ordered]@{
            schemaVersion = 1
            updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
            category = $Category
            exitCode = $ExitCode
            pid = $PID
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $WrapperHealthPath -Force
    } catch {
        # Diagnostics are best-effort and never alter Claude launch behavior.
    }
}

function Normalize-GuardPath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }
    $normalized = [System.IO.Path]::GetFullPath($Value).Replace("/", "\").TrimEnd("\")
    if ($normalized -match "^[A-Za-z]:$") {
        $normalized += "\"
    }
    return $normalized.ToLowerInvariant()
}

function Get-FirstValue {
    param([object[]]$Values)
    foreach ($value in $Values) {
        if ($null -ne $value -and -not [string]::IsNullOrWhiteSpace([string]$value)) {
            return [string]$value
        }
    }
    return $null
}

function Get-LockMatchLength {
    param(
        [object]$Lock,
        [string]$CurrentDirectory
    )
    $paths = @(
        $Lock.workspaceRootPathsNormalized |
            Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
    )
    if ($paths.Count -eq 0) {
        $paths = @([string]$Lock.workspacePathNormalized)
    }
    $longest = 0
    foreach ($candidate in $paths) {
        $normalizedCandidate = [string]$candidate
        $candidatePrefix = "$($normalizedCandidate.TrimEnd('\'))\"
        if ($CurrentDirectory -eq $normalizedCandidate -or
            $CurrentDirectory.StartsWith($candidatePrefix)) {
            $longest = [Math]::Max($longest, $normalizedCandidate.Length)
        }
    }
    return $longest
}

function Start-Claude {
    param(
        [object]$Registry,
        [string]$ProfileId
    )

    if ($null -ne $Registry -and -not [string]::IsNullOrWhiteSpace($ProfileId)) {
        $collector = $Registry.collectors.$ProfileId
        $telemetryProfile = $Registry.profiles |
            Where-Object { [string]$_.id -eq $ProfileId } |
            Select-Object -First 1
        if ($null -ne $collector -and
            $telemetryProfile.telemetryEnabled -eq $true -and
            $Registry.integration.telemetryEnabled -ne $false) {
            try {
                $age = [DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse([string]$collector.updatedAt)
                $existingEndpoints = @(
                    [string]$env:OTEL_EXPORTER_OTLP_ENDPOINT,
                    [string]$env:OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
                    [string]$env:OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
                    [string]$env:OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
                ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
                $existingExporterConfiguration = @(
                    [string]$env:OTEL_METRICS_EXPORTER,
                    [string]$env:OTEL_LOGS_EXPORTER,
                    [string]$env:OTEL_TRACES_EXPORTER,
                    [string]$env:OTEL_EXPORTER_OTLP_HEADERS
                ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
                $canUseLocalCollector = $existingEndpoints.Count -eq 0 -and
                    $existingExporterConfiguration.Count -eq 0
                if ($age.TotalSeconds -le 60 -and [int]$collector.port -gt 0 -and $canUseLocalCollector) {
                    $endpoint = "http://127.0.0.1:$($collector.port)"
                    $env:CLAUDE_ACCOUNT_GUARD_PROFILE_ID = $ProfileId
                    $env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"
                    $env:OTEL_METRICS_EXPORTER = "otlp"
                    $env:OTEL_LOGS_EXPORTER = "otlp"
                    $env:OTEL_TRACES_EXPORTER = "otlp"
                    $env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/json"
                    $env:OTEL_EXPORTER_OTLP_ENDPOINT = $endpoint
                    $env:OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer $($collector.token)"
                    $workspacePath = Normalize-GuardPath (Get-Location).Path
                    $sha = [System.Security.Cryptography.SHA256]::Create()
                    try {
                        $workspaceHash = ([System.BitConverter]::ToString(
                            $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($workspacePath))
                        )).Replace("-", "").ToLowerInvariant().Substring(0, 16)
                    } finally {
                        $sha.Dispose()
                    }
                    $workspaceLabel = [System.IO.Path]::GetFileName($workspacePath.TrimEnd("\"))
                    $workspaceLabel = [System.Text.RegularExpressions.Regex]::Replace(
                        $workspaceLabel,
                        "[^A-Za-z0-9_.-]",
                        "_"
                    )
                    $guardResourceAttributes = @(
                        "claude.account_guard.profile_id=$ProfileId",
                        "claude.account_guard.workspace_hash=$workspaceHash",
                        "claude.account_guard.workspace_label=$workspaceLabel"
                    ) -join ","
                    $env:OTEL_RESOURCE_ATTRIBUTES = if (
                        [string]::IsNullOrWhiteSpace([string]$env:OTEL_RESOURCE_ATTRIBUTES)
                    ) {
                        $guardResourceAttributes
                    } else {
                        "$($env:OTEL_RESOURCE_ATTRIBUTES),$guardResourceAttributes"
                    }
                    $env:OTEL_LOG_USER_PROMPTS = "0"
                    $env:OTEL_LOG_ASSISTANT_RESPONSES = "0"
                    $env:OTEL_LOG_TOOL_DETAILS = "0"
                    $env:OTEL_LOG_TOOL_CONTENT = "0"
                    $env:OTEL_LOG_RAW_API_BODIES = "0"
                }
            } catch {
                # A stale or malformed collector registration disables collection, not Claude.
            }
        }
    }

    $upstream = $null
    if ($null -ne $Registry) {
        $upstream = [string]$Registry.integration.upstreamWrapper
    }
    if (-not [string]::IsNullOrWhiteSpace($upstream) -and (Test-Path -LiteralPath $upstream)) {
        & $upstream $ClaudeBinary @ClaudeArguments
    } else {
        & $ClaudeBinary @ClaudeArguments
    }
    $claudeExitCode = $LASTEXITCODE
    Write-GuardHealth "forwarded" $claudeExitCode
    exit $claudeExitCode
}

function Stop-GuardedLaunch {
    param(
        [string]$Category,
        [string]$Message
    )
    Write-GuardHealth $Category $GuardExitCode
    [Console]::Error.WriteLine("CLAUDE_ACCOUNT_GUARD_BLOCKED category=$Category")
    [Console]::Error.WriteLine($Message)
    exit $GuardExitCode
}

if (-not (Test-Path -LiteralPath $ClaudeBinary -PathType Leaf)) {
    Stop-GuardedLaunch "binary_missing" "Claude Account Guard could not validate the bundled Claude executable."
}

if (-not (Test-Path -LiteralPath $RegistryPath -PathType Leaf)) {
    Start-Claude $null ""
}

try {
    $registry = Get-Content -LiteralPath $RegistryPath -Raw | ConvertFrom-Json
} catch {
    Stop-GuardedLaunch "registry_unavailable" "The Account Guard registry could not be validated. Open Claude Account Guard diagnostics before starting Claude."
}
if ([int]$registry.schemaVersion -ne 1 -or
    $null -eq $registry.profiles -or
    $null -eq $registry.workspaceLocks -or
    $null -eq $registry.collectors -or
    $null -eq $registry.integration) {
    Stop-GuardedLaunch "registry_unavailable" "The Account Guard registry has an unsupported or incomplete schema."
}
foreach ($profile in @($registry.profiles)) {
    if ([string]::IsNullOrWhiteSpace([string]$profile.id) -or
        [string]::IsNullOrWhiteSpace([string]$profile.configDirNormalized)) {
        Stop-GuardedLaunch "registry_unavailable" "The Account Guard registry contains an invalid account profile."
    }
}
foreach ($workspaceLock in @($registry.workspaceLocks)) {
    if ([string]::IsNullOrWhiteSpace([string]$workspaceLock.workspaceUri) -or
        [string]::IsNullOrWhiteSpace([string]$workspaceLock.profileId) -or
        @("enforce", "warn", "off") -notcontains [string]$workspaceLock.mode) {
        Stop-GuardedLaunch "registry_unavailable" "The Account Guard registry contains an invalid workspace lock."
    }
}

$currentDirectory = Normalize-GuardPath (Get-Location).Path
$matchingLocks = @(
    $registry.workspaceLocks | ForEach-Object {
        $matchLength = Get-LockMatchLength $_ $currentDirectory
        if ($_.mode -ne "off" -and $matchLength -gt 0) {
            [PSCustomObject]@{
                Lock = $_
                MatchLength = $matchLength
            }
        }
    } | Sort-Object MatchLength -Descending
)
$lock = $null
if (-not [string]::IsNullOrWhiteSpace([string]$env:CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY)) {
    $lock = $registry.workspaceLocks |
        Where-Object {
            [string]$_.workspaceKey -eq [string]$env:CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY -and
            $_.mode -ne "off" -and
            (Get-LockMatchLength $_ $currentDirectory) -gt 0
        } |
        Select-Object -First 1
}
if ($null -eq $lock) {
    $lock = ($matchingLocks | Select-Object -First 1).Lock
}

$runtimeConfigDir = if ($env:CLAUDE_CONFIG_DIR) {
    $env:CLAUDE_CONFIG_DIR
} else {
    Join-Path $env:USERPROFILE ".claude"
}
$runtimeConfigNormalized = Normalize-GuardPath $runtimeConfigDir
$runtimeProfile = $registry.profiles |
    Where-Object { [string]$_.configDirNormalized -eq $runtimeConfigNormalized } |
    Select-Object -First 1

if ($null -eq $lock -or $lock.mode -ne "enforce") {
    $profileId = if ($null -ne $runtimeProfile) { [string]$runtimeProfile.id } else { "" }
    Start-Claude $registry $profileId
}

$requiredProfile = $registry.profiles |
    Where-Object { [string]$_.id -eq [string]$lock.profileId } |
    Select-Object -First 1

if ($null -eq $requiredProfile) {
    Stop-GuardedLaunch "required_profile_missing" "This workspace has an enforced lock whose account profile no longer exists."
}
if ($null -eq $runtimeProfile -or [string]$runtimeProfile.id -ne [string]$requiredProfile.id) {
    Stop-GuardedLaunch "runtime_profile_mismatch" "This workspace requires '$($requiredProfile.displayName)'. Reopen it with that account from Claude Account Guard."
}

try {
    $authOutput = (& $ClaudeBinary auth status 2>$null | Out-String)
    $authExit = $LASTEXITCODE
    if ($authExit -ne 0) {
        Stop-GuardedLaunch "signed_out" "'$($requiredProfile.displayName)' is not authenticated. Sign in to that isolated profile and verify again."
    }
    $auth = $authOutput | ConvertFrom-Json
} catch {
    Stop-GuardedLaunch "identity_unverifiable" "Claude Account Guard could not verify the active identity through 'claude auth status'."
}

$account = $auth.account
$organization = $auth.organization
$actualAccountId = Get-FirstValue @(
    $auth.accountId, $auth.account_id, $auth.accountUuid, $auth.account_uuid,
    $account.id, $account.uuid
)
$actualEmail = Get-FirstValue @($auth.email, $account.email)
$actualOrganizationId = Get-FirstValue @(
    $auth.organizationId, $auth.organization_id, $auth.orgId,
    $organization.id, $organization.uuid
)
$expected = $requiredProfile.expectedIdentity

$identityMatches = $false
if (-not [string]::IsNullOrWhiteSpace([string]$expected.accountId) -and
    -not [string]::IsNullOrWhiteSpace($actualAccountId)) {
    $identityMatches = [string]$expected.accountId -eq $actualAccountId
} elseif (-not [string]::IsNullOrWhiteSpace([string]$expected.email) -and
          -not [string]::IsNullOrWhiteSpace($actualEmail)) {
    $identityMatches = ([string]$expected.email).Trim().ToLowerInvariant() -eq
        $actualEmail.Trim().ToLowerInvariant()
}

if ($identityMatches -and
    -not [string]::IsNullOrWhiteSpace([string]$expected.organizationId) -and
    -not [string]::IsNullOrWhiteSpace($actualOrganizationId)) {
    $identityMatches = [string]$expected.organizationId -eq $actualOrganizationId
}

if (-not $identityMatches) {
    Stop-GuardedLaunch "identity_mismatch" "The verified Claude identity does not match '$($requiredProfile.displayName)'. No Claude request was started."
}

Start-Claude $registry ([string]$runtimeProfile.id)
