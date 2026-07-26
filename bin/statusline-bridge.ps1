$ErrorActionPreference = "SilentlyContinue"
$rawInput = $input | Out-String
if ([string]::IsNullOrWhiteSpace($rawInput)) {
    exit 0
}

$configDir = if ($env:CLAUDE_CONFIG_DIR) {
    [System.IO.Path]::GetFullPath($env:CLAUDE_CONFIG_DIR)
} else {
    Join-Path $env:USERPROFILE ".claude"
}
$supportRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "ClaudeAccountGuard"
} else {
    Join-Path $env:USERPROFILE ".claude-account-guard"
}
$registryPath = Join-Path $supportRoot "registry.json"
$inbox = Join-Path $supportRoot "snapshots"

try {
    $data = $rawInput | ConvertFrom-Json
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $normalizedConfig = $configDir.Replace("/", "\").TrimEnd("\").ToLowerInvariant()
    $profile = $registry.profiles |
        Where-Object { [string]$_.configDirNormalized -eq $normalizedConfig } |
        Select-Object -First 1

    if ($null -ne $profile -and
        $profile.telemetryEnabled -eq $true -and
        $registry.integration.telemetryEnabled -ne $false -and
        -not [string]::IsNullOrWhiteSpace([string]$data.session_id)) {
        [System.IO.Directory]::CreateDirectory($inbox) | Out-Null
        $workspacePath = [string]$data.workspace.current_dir
        if ([string]::IsNullOrWhiteSpace($workspacePath)) {
            $workspacePath = [string]$data.cwd
        }
        $workspaceLabel = if ([string]::IsNullOrWhiteSpace($workspacePath)) {
            ""
        } else {
            Split-Path $workspacePath -Leaf
        }
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $workspaceHash = if ([string]::IsNullOrWhiteSpace($workspacePath)) {
            ""
        } else {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(
                $workspacePath.Replace("/", "\").TrimEnd("\").ToLowerInvariant()
            )
            ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant().Substring(0, 16)
        }
        $sha.Dispose()

        $snapshot = [ordered]@{
            schemaVersion = 1
            capturedAt = [DateTimeOffset]::UtcNow.ToString("o")
            profileId = [string]$profile.id
            sessionId = [string]$data.session_id
            sessionName = [string]$data.session_name
            workspaceHash = $workspaceHash
            workspaceLabel = $workspaceLabel
            workspacePath = if ($registry.integration.collectWorkspacePath -eq $true) {
                $workspacePath
            } else {
                $null
            }
            modelId = [string]$data.model.id
            modelDisplayName = [string]$data.model.display_name
            effort = [string]$data.effort.level
            thinkingEnabled = $data.thinking.enabled
            fastMode = $data.fast_mode
            costUsd = $data.cost.total_cost_usd
            durationMs = $data.cost.total_duration_ms
            apiDurationMs = $data.cost.total_api_duration_ms
            linesAdded = $data.cost.total_lines_added
            linesRemoved = $data.cost.total_lines_removed
            contextWindow = [ordered]@{
                usedPercentage = $data.context_window.used_percentage
                remainingPercentage = $data.context_window.remaining_percentage
                size = $data.context_window.context_window_size
                totalInputTokens = $data.context_window.total_input_tokens
                totalOutputTokens = $data.context_window.total_output_tokens
                currentUsage = [ordered]@{
                    input = $data.context_window.current_usage.input_tokens
                    output = $data.context_window.current_usage.output_tokens
                    cacheRead = $data.context_window.current_usage.cache_read_input_tokens
                    cacheCreation = $data.context_window.current_usage.cache_creation_input_tokens
                }
            }
            rateLimits = [ordered]@{
                fiveHour = [ordered]@{
                    usedPercentage = $data.rate_limits.five_hour.used_percentage
                    resetsAt = $data.rate_limits.five_hour.resets_at
                }
                sevenDay = [ordered]@{
                    usedPercentage = $data.rate_limits.seven_day.used_percentage
                    resetsAt = $data.rate_limits.seven_day.resets_at
                }
            }
        }

        $fileName = "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([Guid]::NewGuid().ToString('n')).json"
        $target = Join-Path $inbox $fileName
        $temporary = "$target.tmp"
        $snapshot | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
        Move-Item -LiteralPath $temporary -Destination $target -Force
    }
} catch {
    # Snapshot collection must never delay or break Claude's status line.
}

try {
    $bridgeConfigPath = Join-Path $configDir ".claude-account-guard\statusline-next.json"
    if (Test-Path -LiteralPath $bridgeConfigPath -PathType Leaf) {
        $bridge = Get-Content -LiteralPath $bridgeConfigPath -Raw | ConvertFrom-Json
        $nextCommand = if (
            -not [string]::IsNullOrWhiteSpace([string]$bridge.nextStatusLine.command)
        ) {
            [string]$bridge.nextStatusLine.command
        } else {
            [string]$bridge.nextCommand
        }
        if (-not [string]::IsNullOrWhiteSpace($nextCommand)) {
            $rawInput | & cmd.exe /d /s /c $nextCommand
            exit $LASTEXITCODE
        }
    }
} catch {
    exit 0
}
