#Requires -Version 5.1
<#
.SYNOPSIS
    Installs or upgrades Launchway on Windows with Docker Desktop.

.DESCRIPTION
    Installs the Launchway control plane (the API with the web UI, the bundled
    node agent, the Caddy edge proxy and PostgreSQL) with Docker Compose into
    one directory, generates its secrets and starts it.

    Running it again is safe and upgrades the installation: the settings and
    secrets in the existing .env are kept (only values passed as parameters
    change), compose.yaml and the Caddyfile are refreshed and the images are
    pulled again.

.PARAMETER Dir
    Installation directory. Default: $env:LAUNCHWAY_DIR, otherwise
    $env:USERPROFILE\launchway.

.PARAMETER Email
    Contact e-mail for Let's Encrypt certificates. Default:
    $env:LAUNCHWAY_ACME_EMAIL. Required on the first install; asked for when the
    session is interactive.

.PARAMETER Port
    Host port of the web UI and API. Default: $env:LAUNCHWAY_PORT, the value in
    .env, or 3000.

.PARAMETER Version
    Launchway image tag, for example v0.1.0. Default: $env:LAUNCHWAY_VERSION, the
    value in .env, or latest.

.EXAMPLE
    irm https://raw.githubusercontent.com/JensPenneman/launchway/main/deploy/install.ps1 | iex

    Downloads and runs the installer, which asks for the e-mail address. Set
    $env:LAUNCHWAY_ACME_EMAIL (and optionally LAUNCHWAY_DIR, LAUNCHWAY_PORT and
    LAUNCHWAY_VERSION) first to run it without questions.

.EXAMPLE
    .\install.ps1 -Email ops@example.com -Port 8080

.NOTES
    When compose.yaml and the Caddyfile are not next to this script, they are
    downloaded from GitHub; $env:LAUNCHWAY_REF selects the Git ref (default: the
    release tag vX.Y.Z for a release version, main for latest and edge).
#>
[CmdletBinding()]
param(
    [string] $Dir = $(if ($env:LAUNCHWAY_DIR) { $env:LAUNCHWAY_DIR } else { Join-Path $env:USERPROFILE 'launchway' }),
    [string] $Email = $env:LAUNCHWAY_ACME_EMAIL,
    [int] $Port = $(if ($env:LAUNCHWAY_PORT) { $env:LAUNCHWAY_PORT } else { 0 }),
    [string] $Version = $env:LAUNCHWAY_VERSION
)

# The installer runs in a child scope, so that `irm ... | iex` leaves no
# variables, preferences or strict mode behind in the caller's session. For the
# same reason a failure stops the installer with a message instead of calling
# exit, which would close that session.
& {
    param([string] $Dir, [string] $Email, [int] $Port, [string] $Version)

    # Both are empty when the script is piped into iex instead of run from a file.
    $scriptRoot = ''
    $scriptPath = ''
    try {
        $scriptRoot = [string] $PSScriptRoot
        $scriptPath = [string] $PSCommandPath
    } catch {
        $scriptRoot = ''
    }

    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Set-StrictMode -Version Latest

    $ProxyNetwork = 'launchway-proxy'
    $ProxySubnet = '10.210.0.0/24'
    # Dynamic addresses come from the upper half only, so that no container can
    # take Caddy's fixed address 10.210.0.2 while Caddy is down.
    $ProxyIpRange = '10.210.0.128/25'
    $DbVolume = 'launchway_db-data'
    $RawBaseUrl = 'https://raw.githubusercontent.com/JensPenneman/launchway'
    $EnvKeys = @('LAUNCHWAY_VERSION', 'LAUNCHWAY_PORT', 'LAUNCHWAY_PUBLIC_URL', 'LAUNCHWAY_ACME_EMAIL',
        'LAUNCHWAY_SECRET_KEY', 'LAUNCHWAY_LOCAL_JOIN_TOKEN', 'LAUNCHWAY_SETUP_TOKEN', 'POSTGRES_PASSWORD', 'LOG_LEVEL')

    function Write-Step([string] $Message) {
        Write-Host '==> ' -ForegroundColor Cyan -NoNewline
        Write-Host $Message
    }

    # Windows PowerShell 5.1 turns the stderr output of a redirected native
    # command into error records, which 'Stop' makes fatal. docker therefore
    # runs with 'Continue' and is judged by its exit code only.

    # Runs docker with its output on the console; returns whether it succeeded.
    function Invoke-Docker([string[]] $Arguments) {
        $ErrorActionPreference = 'Continue'
        & docker @Arguments | Out-Host
        return ($LASTEXITCODE -eq 0)
    }

    # Runs docker quietly; returns its exit status, stdout and stderr.
    function Invoke-DockerCapture([string[]] $Arguments) {
        $ErrorActionPreference = 'Continue'
        $stdout = New-Object System.Collections.Generic.List[string]
        $stderr = New-Object System.Collections.Generic.List[string]
        & docker @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { $stderr.Add("$_") } else { $stdout.Add("$_") }
        }
        return [pscustomobject] @{
            Ok     = ($LASTEXITCODE -eq 0)
            Output = ($stdout -join "`n").Trim()
            Errors = ($stderr -join "`n").Trim()
        }
    }

    function Get-RandomByteArray([int] $Count) {
        $bytes = New-Object byte[] $Count
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $rng.GetBytes($bytes)
        } finally {
            $rng.Dispose()
        }
        return , $bytes
    }

    # The prefix ("lwyn_" by default) followed by 43 characters from A-Z, a-z and 0-9.
    function New-JoinToken([string] $Prefix = 'lwyn_') {
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        $token = New-Object System.Text.StringBuilder -ArgumentList $Prefix
        while ($token.Length -lt 48) {
            foreach ($byte in (Get-RandomByteArray 64)) {
                # 248 = 4 * 62: dropping larger bytes keeps all characters equally likely.
                if ($byte -lt 248 -and $token.Length -lt 48) {
                    [void] $token.Append($alphabet[$byte % 62])
                }
            }
        }
        return $token.ToString()
    }

    function Get-Unquoted([string] $Value) {
        if ($Value -match '^([''"])(.*)\1$') { return $Matches[2] }
        return $Value
    }

    # Value of Key in the .env lines: the last occurrence, without surrounding quotes.
    function Get-EnvValue([string[]] $Lines, [string] $Key) {
        $value = ''
        foreach ($line in $Lines) {
            if ($line.StartsWith("$Key=", [System.StringComparison]::Ordinal)) {
                $value = $line.Substring($Key.Length + 1)
            }
        }
        return (Get-Unquoted $value)
    }

    # Returns the new .env lines: a missing key is appended, an existing line is
    # only rewritten when its value differs, and every other line is kept.
    function Merge-EnvContent([string[]] $Lines, [System.Collections.Specialized.OrderedDictionary] $Values) {
        $result = New-Object System.Collections.Generic.List[string]
        $seen = @{}
        foreach ($line in $Lines) {
            foreach ($key in $Values.Keys) {
                if ($line.StartsWith("$key=", [System.StringComparison]::Ordinal)) {
                    $seen[$key] = $true
                    if ((Get-Unquoted $line.Substring($key.Length + 1)) -cne $Values[$key]) {
                        $line = "$key=$($Values[$key])"
                    }
                    break
                }
            }
            $result.Add($line)
        }
        foreach ($key in $Values.Keys) {
            if (-not $seen.ContainsKey($key)) { $result.Add("$key=$($Values[$key])") }
        }
        return , $result.ToArray()
    }

    # Replaces the file's ACL with a single entry for the current user.
    function Set-OwnerOnlyAcl([string] $Path) {
        $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule -ArgumentList $user, 'FullControl', 'Allow'
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $Path -AclObject $acl
    }

    # Best effort: the address of the interface that holds the default route.
    function Get-LanAddress {
        try {
            $socket = New-Object System.Net.Sockets.Socket -ArgumentList ([System.Net.Sockets.AddressFamily]::InterNetwork),
                ([System.Net.Sockets.SocketType]::Dgram), ([System.Net.Sockets.ProtocolType]::Udp)
            try {
                # Connecting a UDP socket only selects the route; nothing is sent.
                $socket.Connect('1.1.1.1', 53)
                return $socket.LocalEndPoint.Address.ToString()
            } finally {
                $socket.Close()
            }
        } catch {
            return 'localhost'
        }
    }

    function Install-Launchway([string] $Dir, [string] $Email, [int] $Port, [string] $Version) {
        # Docker Desktop
        if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
            throw 'Docker was not found. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/), start it and run the installer again.'
        }
        if (-not (Invoke-DockerCapture @('compose', 'version')).Ok) {
            throw "Docker Compose v2 is not available ('docker compose version' failed). Update Docker Desktop and run the installer again."
        }
        $info = Invoke-DockerCapture @('info', '--format', '{{.OSType}}')
        if (-not $info.Ok) {
            throw 'Docker is not running. Start Docker Desktop, wait until the engine is running and run the installer again.'
        }
        if ($info.Output -ne 'linux') {
            throw 'Docker Desktop runs Windows containers. Switch it to Linux containers and run the installer again.'
        }

        # Settings: parameters win, then the existing .env, then the defaults.
        $Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)
        $envFile = Join-Path $Dir '.env'
        [string[]] $envLines = @()
        if (Test-Path -LiteralPath $envFile -PathType Leaf) {
            try {
                $envLines = [System.IO.File]::ReadAllLines($envFile)
            } catch {
                throw "Cannot read ${envFile}: $($_.Exception.Message) Run the installer as the user that installed Launchway."
            }
        }

        if (-not $Email) { $Email = Get-EnvValue $envLines 'LAUNCHWAY_ACME_EMAIL' }
        if (-not $Email -and [Environment]::UserInteractive) {
            try {
                $Email = ([string] (Read-Host "Contact e-mail for Let's Encrypt certificates")).Trim()
            } catch {
                $Email = ''
            }
        }
        if (-not $Email) {
            throw 'An e-mail address for Let''s Encrypt is required: pass -Email <address> or set $env:LAUNCHWAY_ACME_EMAIL.'
        }
        if ($Email -notmatch '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') {
            throw "'$Email' does not look like an e-mail address."
        }

        if ($Port -eq 0) {
            $existingPort = Get-EnvValue $envLines 'LAUNCHWAY_PORT'
            if (-not $existingPort) {
                $Port = 3000
            } elseif ($existingPort -match '^\d{1,5}$') {
                $Port = [int] $existingPort
            } else {
                throw "LAUNCHWAY_PORT in $envFile is not a port number: '$existingPort'."
            }
        }
        if ($Port -lt 1 -or $Port -gt 65535) {
            throw "Invalid port ${Port}: use a number from 1 to 65535."
        }
        if ($Port -eq 80 -or $Port -eq 443) {
            throw "Port $Port belongs to the Caddy edge proxy; choose another -Port."
        }

        if (-not $Version) { $Version = Get-EnvValue $envLines 'LAUNCHWAY_VERSION' }
        if (-not $Version) { $Version = 'latest' }
        $Version = $Version -replace '^v(?=\d)', ''
        if ($Version -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$') {
            throw "Invalid version '$Version': use an image tag such as 0.1.0 or latest."
        }

        $publicUrl = Get-EnvValue $envLines 'LAUNCHWAY_PUBLIC_URL'
        $logLevel = Get-EnvValue $envLines 'LOG_LEVEL'
        if (-not $logLevel) { $logLevel = 'info' }

        # Secrets: existing ones are kept, missing ones are generated.
        $secretKey = Get-EnvValue $envLines 'LAUNCHWAY_SECRET_KEY'
        $dbPassword = Get-EnvValue $envLines 'POSTGRES_PASSWORD'
        $joinToken = Get-EnvValue $envLines 'LAUNCHWAY_LOCAL_JOIN_TOKEN'
        $setupToken = Get-EnvValue $envLines 'LAUNCHWAY_SETUP_TOKEN'
        if ((-not $secretKey -or -not $dbPassword) -and (Invoke-DockerCapture @('volume', 'inspect', $DbVolume)).Ok) {
            throw ("The Docker volume $DbVolume holds an existing Launchway database, but $envFile does not have its secrets. " +
                "Restore .env from your backup into $Dir, or point -Dir at the existing installation. " +
                "To start over and delete all Launchway data instead, remove the old containers and run: docker volume rm $DbVolume")
        }
        $freshInstall = -not $secretKey
        if (-not $secretKey) { $secretKey = [Convert]::ToBase64String((Get-RandomByteArray 32)) }
        if (-not $dbPassword) { $dbPassword = [BitConverter]::ToString((Get-RandomByteArray 32)).Replace('-', '').ToLowerInvariant() }
        if (-not $joinToken) { $joinToken = New-JoinToken }
        # Required by the first-run setup, so that only the operator can create the owner.
        if (-not $setupToken) { $setupToken = New-JoinToken 'lwys_' }

        # Network shared by Caddy, the platform and every routed app.
        $network = Invoke-DockerCapture @('network', 'inspect', '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}', $ProxyNetwork)
        if (-not $network.Ok) {
            Write-Step "Creating Docker network $ProxyNetwork ($ProxySubnet)"
            $created = Invoke-DockerCapture @('network', 'create', '--driver', 'bridge', '--subnet', $ProxySubnet, '--ip-range', $ProxyIpRange, $ProxyNetwork)
            if (-not $created.Ok) {
                throw "Could not create the Docker network $ProxyNetwork ($($created.Errors)). If $ProxySubnet overlaps another network, free that range first."
            }
        } elseif ((" " + $network.Output + " ") -notlike "* $ProxySubnet *") {
            $current = if ($network.Output) { $network.Output } else { '(none)' }
            Write-Warning ("The Docker network $ProxyNetwork already exists with subnet $current, not $ProxySubnet. " +
                "Caddy's fixed address 10.210.0.2 and LAUNCHWAY_TRUSTED_PROXIES assume $ProxySubnet; recreate the network or adapt compose.yaml.")
        }

        # compose.yaml and Caddyfile: from next to this script when it runs from
        # a checkout, downloaded otherwise (irm ... | iex).
        $null = New-Item -ItemType Directory -Force -Path $Dir
        $haveLocalFiles = $scriptRoot -and
            (Test-Path -LiteralPath (Join-Path $scriptRoot 'compose.yaml') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $scriptRoot 'Caddyfile') -PathType Leaf)
        if ($haveLocalFiles) {
            if ([System.IO.Path]::GetFullPath($scriptRoot).TrimEnd('\') -ne $Dir.TrimEnd('\')) {
                Write-Step "Copying compose.yaml and Caddyfile from $scriptRoot"
                foreach ($name in 'compose.yaml', 'Caddyfile') {
                    Copy-Item -LiteralPath (Join-Path $scriptRoot $name) -Destination (Join-Path $Dir $name) -Force
                }
            }
        } else {
            # A pinned release gets the compose file and Caddyfile it was released with.
            $ref = 'main'
            if ($env:LAUNCHWAY_REF) { $ref = $env:LAUNCHWAY_REF }
            elseif ($Version -match '^\d+\.\d+\.\d+$') { $ref = "v$Version" }
            if ($ref -notmatch '^[A-Za-z0-9._/][A-Za-z0-9._/-]*$') {
                throw "Invalid LAUNCHWAY_REF '$ref'."
            }
            # Windows PowerShell 5.1 does not always offer TLS 1.2 by default.
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            Write-Step "Downloading compose.yaml and Caddyfile ($ref)"
            foreach ($name in 'compose.yaml', 'Caddyfile') {
                $url = "$RawBaseUrl/$ref/deploy/$name"
                $target = Join-Path $Dir $name
                try {
                    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile "$target.download"
                } catch {
                    Remove-Item -LiteralPath "$target.download" -Force -ErrorAction SilentlyContinue
                    throw "Could not download ${url}: $($_.Exception.Message)"
                }
                Move-Item -LiteralPath "$target.download" -Destination $target -Force
            }
        }

        # .env
        $values = [ordered] @{
            LAUNCHWAY_VERSION          = $Version
            LAUNCHWAY_PORT             = [string] $Port
            LAUNCHWAY_PUBLIC_URL       = $publicUrl
            LAUNCHWAY_ACME_EMAIL       = $Email
            LAUNCHWAY_SECRET_KEY       = $secretKey
            LAUNCHWAY_LOCAL_JOIN_TOKEN = $joinToken
            LAUNCHWAY_SETUP_TOKEN      = $setupToken
            POSTGRES_PASSWORD          = $dbPassword
            LOG_LEVEL                  = $logLevel
        }
        if ($envLines.Count -gt 0) {
            Write-Step "Updating $envFile (existing values are kept)"
            $baseLines = $envLines
        } else {
            Write-Step "Writing $envFile"
            $baseLines = @(
                '# Launchway configuration, written by install.ps1. Every key is described in'
                '# deploy/.env.example in the Launchway repository.'
                '#'
                '# Back up this file. Losing LAUNCHWAY_SECRET_KEY makes all stored secrets'
                '# unrecoverable, and the database only accepts the POSTGRES_PASSWORD it was'
                '# created with.'
            )
        }
        $newLines = Merge-EnvContent $baseLines $values
        # UTF-8 without BOM and with LF line endings: Docker Compose would read a
        # BOM as part of the first key.
        [System.IO.File]::WriteAllText($envFile, (($newLines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
        try {
            Set-OwnerOnlyAcl $envFile
        } catch {
            Write-Warning "Could not restrict access to $envFile to the current user: $($_.Exception.Message)"
        }

        # Start
        $composeArgs = @('compose', '--project-directory', $Dir, '-f', (Join-Path $Dir 'compose.yaml'))
        $override = Join-Path $Dir 'compose.override.yaml'
        if (Test-Path -LiteralPath $override -PathType Leaf) { $composeArgs += @('-f', $override) }

        # Compose prefers variables from the environment over .env: let .env
        # decide, and restore the caller's environment afterwards.
        $savedEnv = @{}
        foreach ($key in $EnvKeys) {
            $item = Get-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
            if ($null -ne $item) {
                $savedEnv[$key] = $item.Value
                Remove-Item -LiteralPath "Env:$key"
            }
        }
        try {
            Write-Step "Pulling images (LAUNCHWAY_VERSION=$Version)"
            if (-not (Invoke-Docker ($composeArgs + 'pull'))) {
                throw "Pulling the images failed. Check the network connection and that the tag '$Version' exists."
            }
            Write-Step 'Starting Launchway'
            if (-not (Invoke-Docker ($composeArgs + @('up', '-d', '--wait', '--wait-timeout', '300', '--remove-orphans')))) {
                $null = Invoke-Docker ($composeArgs + 'ps')
                throw "Launchway did not start cleanly. Inspect the logs with: cd `"$Dir`"; docker compose logs"
            }
        } finally {
            foreach ($key in $savedEnv.Keys) { Set-Item -LiteralPath "Env:$key" -Value $savedEnv[$key] }
        }

        $url = "http://$(Get-LanAddress):$Port/"
        Write-Host ''
        Write-Host 'Launchway is running.' -ForegroundColor Green
        Write-Host ''
        Write-Host "  Web UI: $url"
        Write-Host ''
        if ($freshInstall) {
            Write-Host (@(
                    'Next steps:'
                    '  1. Create the owner account now with this one-time link (it carries the'
                    "     setup token, LAUNCHWAY_SETUP_TOKEN in $envFile):"
                    "     ${url}setup#token=$setupToken"
                    '  2. Forward TCP ports 80 and 443 (and UDP 443 for HTTP/3) from your router to'
                    '     this machine and allow them in Windows Defender Firewall, then add your'
                    '     domain in the web UI.'
                    "  3. Back up $envFile. Losing LAUNCHWAY_SECRET_KEY makes the stored secrets"
                    '     unrecoverable.'
                    ''
                ) -join [Environment]::NewLine)
        }
        Write-Host (@(
                "Manage the installation from ${Dir}:"
                '  docker compose ps                                     status'
                '  docker compose logs -f launchway                      API logs'
                '  docker compose pull; docker compose up -d --wait      upgrade'
            ) -join [Environment]::NewLine)
    }

    try {
        Install-Launchway -Dir $Dir -Email $Email -Port $Port -Version $Version
    } catch {
        Write-Host "error: $($_.Exception.Message)" -ForegroundColor Red
        # A script file reports the failure through its exit code; under iex,
        # exit would close the caller's session, so the installer just stops.
        if ($scriptPath) { exit 1 }
    }
} $Dir $Email $Port $Version
