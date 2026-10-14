#requires -Version 7.4
<#
Build a local candidate with .\scripts\release.ps1 -AllowDirty.
Omit -AllowDirty for a clean-source build. This script never publishes a release.
HostedCI is restricted to GitHub-hosted runners; every local Cargo call uses the
unchanged shared buildlock. Compilation and Tauri bundle-only are separate calls.

Tool provenance:
https://github.com/rust-secure-code/cargo-auditable/releases/tag/v0.7.7
https://github.com/tauri-apps/tauri/releases/tag/tauri-cli-v2.10.1
https://github.com/ip7z/7zip/releases/tag/26.04
https://v2.tauri.app/reference/cli/#bundle
#>
[CmdletBinding()]
param([switch]$AllowDirty, [switch]$HostedCI)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildGate = 'D:/PhaseForge-claude/scripts/buildlock.py'
$targetTriple = 'x86_64-pc-windows-msvc'
$toolchain = '1.98.1'
$savedEnvironment = @{}
foreach ($name in @('PATH', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'RUSTUP_TOOLCHAIN')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$originalLocation = Get-Location
$steps = [Collections.Generic.List[object]]::new()
$receipt = $null
$output = $null

function Invoke-ProjectCargo {
    param([Parameter(Mandatory)][string[]]$CargoArgs, [Parameter(Mandatory)][string]$Stage)
    $started = [DateTime]::UtcNow
    $log = Join-Path $output "$Stage.log"
    Write-Host "CodaClauda: $Stage"
    if ($HostedCI) {
        & cargo @CargoArgs 2>&1 | Tee-Object -FilePath $log | Out-Host
    } else {
        # Do not replace this gate, override its memory threshold, or nest it.
        & python -I D:/PhaseForge-claude/scripts/buildlock.py -- cargo @CargoArgs 2>&1 | Tee-Object -FilePath $log | Out-Host
    }
    $code = $LASTEXITCODE
    $steps.Add([ordered]@{stage=$Stage; argv=@('cargo') + $CargoArgs; exit_code=$code; started_at=$started.ToString('o'); finished_at=[DateTime]::UtcNow.ToString('o')})
    if ($code -ne 0) { throw "Cargo stage $Stage failed with exit $code. See $log." }
}

function Install-PinnedTool {
    param([string]$Name, [string]$Version, [string]$Uri, [string]$Sha256, [string]$Executable)
    $directory = Join-Path $projectRoot "local/release-tools/$Name-$Version"
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $archive = Join-Path $directory 'download.zip'
    if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $Uri -OutFile $archive }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { throw "$Name $Version checksum mismatch; keep the failed download for inspection: $archive" }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $directory 'unpacked') -Force
    $binaries = @(Get-ChildItem -LiteralPath (Join-Path $directory 'unpacked') -Filter $Executable -File -Recurse)
    if ($binaries.Count -ne 1) { throw "Expected exactly one $Executable in the verified $Name archive." }
    $env:PATH = "$($binaries[0].DirectoryName);$env:PATH"
    return [ordered]@{name=$Name; version=$Version; url=$Uri; sha256=$actual}
}

function Install-PinnedSevenZip {
    # Extract the official installer as an archive; never execute its installer.
    # The small official 7zr bootstrap can unpack 7z archives, but full 7z+DLL
    # are needed afterward because NSIS is not a supported bootstrap format.
    $directory = Join-Path $projectRoot 'local/release-tools/7zip-26.04'
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $downloads = @(
        @{name='7zr.exe'; sha256='256feca8e274e5da655e2a284fabafd9f554365eb164862089dacd4e8276d282'},
        @{name='7z2604-x64.exe'; sha256='d54bf805f9f3704d1e8db2fa3498ae7ef2df0312b40b558e7c71c734430a665d'}
    )
    foreach ($download in $downloads) {
        $path = Join-Path $directory $download.name
        if (!(Test-Path -LiteralPath $path)) { Invoke-WebRequest -Uri "https://github.com/ip7z/7zip/releases/download/26.04/$($download.name)" -OutFile $path }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $download.sha256) { throw "Official 7-Zip checksum mismatch: $path" }
    }
    $unpacked = Join-Path $directory 'unpacked'
    & (Join-Path $directory '7zr.exe') x (Join-Path $directory '7z2604-x64.exe') "-o$unpacked" '7z.exe' '7z.dll' 'License.txt' 'readme.txt' -y | Out-File -LiteralPath (Join-Path $output 'prepare-7zip.log') -Encoding utf8
    $executable = Join-Path $unpacked '7z.exe'
    $dll = Join-Path $unpacked '7z.dll'
    if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() -ne '95fff19b73eff77c87c0d7bd32822e43fb90dd2932459f962eb532d8dfb6ba53' -or (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant() -ne '899cd73d7fc60e1c1c35c7de0f5bed3dc69bfe2ceCBD48014d868a347970a0b1'.ToLowerInvariant()) { throw 'Extracted full 7-Zip bytes differ from the verified official archive.' }
    $formats = & $executable i
    if (!($formats -match '\bNsis\b')) { throw 'The full extraction tool does not advertise NSIS support.' }
    return @{path=$executable; provenance=[ordered]@{name='7-Zip'; version='26.04'; source='https://github.com/ip7z/7zip/releases/tag/26.04'; archive_sha256=$downloads[1].sha256; bootstrap_sha256=$downloads[0].sha256; executable_sha256=(Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant(); usage='build-time extraction only; not installed globally or bundled'}}
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This is a Windows x64 packaging recipe.' }
    if ($HostedCI) {
        if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
            throw '-HostedCI is permitted only on GitHub-hosted runners. Local builds must use the shared gate.'
        }
    } else {
        if (![IO.Path]::GetPathRoot($projectRoot).Equals('C:\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Local builds require this project and its Cargo target under C:.' }
        if (!(Test-Path -LiteralPath $buildGate -PathType Leaf)) { throw "Shared build gate missing: $buildGate" }
        if ($env:BUILDLOCK_MIN_FREE_GB) { throw 'Remove BUILDLOCK_MIN_FREE_GB overrides before using the unchanged shared build gate.' }
    }
    Set-Location -LiteralPath $projectRoot
    foreach ($command in @('git', 'python', 'node', 'cargo', 'rustc')) { Get-Command $command -ErrorAction Stop | Out-Null }
    $gitRoot = (& git rev-parse --show-toplevel).Trim()
    if (![IO.Path]::GetFullPath($gitRoot).Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'The script must run from the CodaClauda repository root.' }
    $commit = (& git rev-parse HEAD).Trim()
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'A full source commit is required.' }
    $dirty = @(& git status --porcelain=v1 --untracked-files=all)
    if ($dirty.Count -gt 0 -and !$AllowDirty) { throw "Source is dirty. Commit reviewed source first, or explicitly use -AllowDirty for a local candidate. No build started.`n$($dirty -join "`n")" }
    foreach ($required in @('Cargo.lock', 'src-tauri/Cargo.lock', 'LICENSE', 'PROVENANCE.md', 'THIRD_PARTY_NOTICES.md', 'scripts/notices.py')) {
        if (!(Test-Path -LiteralPath $required -PathType Leaf) -or (Get-Item -LiteralPath $required).Length -eq 0) { throw "Required release source is missing or empty: $required" }
    }
    $config = Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    if ($config.productName -ne 'CodaClauda' -or $config.identifier -ne 'com.deloresai.codaclauda' -or $config.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $config.version -eq '0.0.0') { throw 'Final product identity/version must be real; placeholders are forbidden.' }
    if ($config.bundle.windows.nsis.installMode -ne 'currentUser' -or $config.bundle.windows.webviewInstallMode.type -ne 'skip') { throw 'Expected per-user NSIS and existing WebView2; re-review installer configuration.' }
    if ($config.build.PSObject.Properties.Name -contains 'beforeBundleCommand') { throw 'A beforeBundleCommand is not allowed in this bundle-only recipe; it could rebuild within the gate.' }
    $version = $config.version
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
    $flavor = if ($dirty.Count -gt 0) { 'dirty-candidate' } else { 'clean-candidate' }
    $output = Join-Path $projectRoot "dist/releases/$version-$($commit.Substring(0,12))-$flavor-$stamp"
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $target = [IO.Path]::GetFullPath((Join-Path $projectRoot 'target/release-build'))
    if (!$target.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cargo target escaped this repository.' }
    $env:CARGO_TARGET_DIR = $target
    $env:CARGO_HOME = Join-Path $projectRoot 'local/cargo-home'
    New-Item -ItemType Directory -Path $env:CARGO_HOME -Force | Out-Null
    $env:RUSTUP_TOOLCHAIN = $toolchain
    $rustVersion = (& rustc --version).Trim()
    if ($rustVersion -notmatch '^rustc 1\.98\.1\b') { throw "Expected installed Rust $toolchain, found $rustVersion. Install the exact toolchain explicitly first." }
    $receipt = [ordered]@{schema_version=1; product='CodaClauda'; version=$version; source_commit=$commit; clean_source=($dirty.Count -eq 0); allow_dirty=[bool]$AllowDirty; flavor=$flavor; target=$targetTriple; rust=$rustVersion; mode=$(if ($HostedCI) {'github-hosted'} else {'local-shared-gate'}); started_at=[DateTime]::UtcNow.ToString('o'); result='building'; acceptance=[ordered]@{unit_and_fixture_tests='pending'; package_integrity='pending'; installed_native_workflow='not performed by this script'; model_provider_workflow='not performed by this script'; marketplace_admission='not performed by this script'; published=$false}; steps=$steps; tools=@()}
    if (!$HostedCI) { $receipt.build_gate_sha256 = (Get-FileHash -LiteralPath $buildGate -Algorithm SHA256).Hash.ToLowerInvariant() }
    $receipt.tools += Install-PinnedTool -Name 'cargo-auditable' -Version '0.7.7' -Uri 'https://github.com/rust-secure-code/cargo-auditable/releases/download/v0.7.7/cargo-auditable-x86_64-pc-windows-msvc.zip' -Sha256 '717ba2d3ed7997c501e9987ee7c94bebf9d7219b18b185a03009420ec7029c7d' -Executable 'cargo-auditable.exe'
    $receipt.tools += Install-PinnedTool -Name 'cargo-tauri' -Version '2.10.1' -Uri 'https://github.com/tauri-apps/tauri/releases/download/tauri-cli-v2.10.1/cargo-tauri-x86_64-pc-windows-msvc.zip' -Sha256 '50a3ed1c43f75ea3b6e7233a52d8a7c994cfffd98d8545ff397db8b464338d9c' -Executable 'cargo-tauri.exe'
    $sevenZipTool = Install-PinnedSevenZip
    $sevenZip = $sevenZipTool.path
    $receipt.tools += $sevenZipTool.provenance

    # Standard-library-only inspection: hashes Git-visible source, verifies the
    # PE .dep-v0 section, emits the exact audit record and CycloneDX components.
    $inspector = Join-Path $projectRoot 'local/release-tools/inspect_release.py'
    @'
import hashlib, json, struct, subprocess, sys, tomllib, urllib.parse, zipfile, zlib
from pathlib import Path

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def source(root):
    root = Path(root)
    paths = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
    files = []
    for relative in sorted(set(filter(None, paths))):
        p = root / relative
        if not p.is_file() or p.is_symlink():
            raise ValueError('Source contains a missing file or symlink: ' + relative)
        if any(part.lower() in {'.env', 'credentials.json', 'auth.json', 'id_rsa', 'id_ed25519'} for part in p.parts):
            raise ValueError('Sensitive-looking source file must be removed from release source: ' + relative)
        files.append({'path':relative, 'sha256':digest(p), 'bytes':p.stat().st_size})
    return files

def pe(path):
    raw = Path(path).read_bytes()
    if raw[:2] != b'MZ': raise ValueError('Not a Windows PE executable')
    offset = struct.unpack_from('<I', raw, 0x3c)[0]
    if raw[offset:offset+4] != b'PE\0\0': raise ValueError('Invalid PE signature')
    machine, count = struct.unpack_from('<HH', raw, offset+4)
    if machine != 0x8664: raise ValueError('Expected Windows x64 payload')
    opt_size = struct.unpack_from('<H', raw, offset+20)[0]
    start = offset+24+opt_size
    sections = []
    for n in range(count):
        at = start+n*40
        name = raw[at:at+8].rstrip(b'\0')
        virtual_size, virtual_addr, size, pointer = struct.unpack_from('<IIII', raw, at+8)
        sections.append((name, virtual_addr, max(virtual_size,size), pointer, size))
    return raw, offset, sections

def audit(path, destination):
    raw, offset, sections = pe(path)
    candidates = [section for section in sections if section[0] == b'.dep-v0']
    if len(candidates) != 1: raise ValueError('Mandatory cargo-auditable .dep-v0 metadata is missing: '+str(path))
    _, _, _, pointer, size = candidates[0]
    metadata = json.loads(zlib.decompress(raw[pointer:pointer+size]))
    packages = metadata.get('packages', [])
    if not packages: raise ValueError('Empty auditable dependency metadata')
    destination = Path(destination)
    stem = Path(path).stem
    (destination / (stem+'.dependencies.json')).write_text(json.dumps(metadata,indent=2)+'\n', encoding='utf-8')
    components = []
    for i, package in enumerate(packages):
        name, version = package['name'], package['version']
        components.append({'type':'library', 'bom-ref':str(i), 'name':name, 'version':version,
                           'purl':'pkg:cargo/'+urllib.parse.quote(name, safe='')+'@'+urllib.parse.quote(version, safe=''),
                           'properties':[{'name':'cargo-auditable:source','value':str(package.get('source','unknown'))}]})
    bom = {'bomFormat':'CycloneDX','specVersion':'1.6','version':1,'components':components,
           'dependencies':[{'ref':str(i),'dependsOn':[str(j) for j in package.get('dependencies',[])]} for i,package in enumerate(packages)]}
    (destination / (stem+'.sbom.cdx.json')).write_text(json.dumps(bom,indent=2)+'\n',encoding='utf-8')
    print(stem+': verified cargo-auditable metadata; '+str(len(packages))+' dependency records')

mode = sys.argv[1]
if mode == 'snapshot':
    Path(sys.argv[3]).write_text(json.dumps(source(sys.argv[2]),indent=2)+'\n',encoding='utf-8')
elif mode == 'source-zip':
    root, manifest, dest = Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4])
    with zipfile.ZipFile(dest,'w',zipfile.ZIP_DEFLATED) as z:
        for record in json.loads(manifest.read_text()): z.write(root/record['path'],record['path'])
elif mode == 'audit':
    audit(sys.argv[2],sys.argv[3])
elif mode == 'versions':
    root=Path(sys.argv[2]); expected=sys.argv[3]
    for path, key in [('Cargo.toml',('workspace','package')),('src-tauri/Cargo.toml',('package',))]:
        value=tomllib.loads((root/path).read_text())
        for part in key: value=value[part]
        if value.get('version') != expected or value.get('license') != 'MIT': raise ValueError('Version/license mismatch: '+path)
    manifest=(root/'src-tauri/app.manifest').read_text()
    if 'level="asInvoker"' not in manifest or 'uiAccess="false"' not in manifest: raise ValueError('Desktop manifest must specify asInvoker/uiAccess=false')
    gui=tomllib.loads((root/'src-tauri/Cargo.toml').read_text())
    if 'tauri/custom-protocol' not in gui.get('features',{}).get('custom-protocol',[]): raise ValueError('Direct release build needs custom-protocol feature')
else: raise ValueError('Unknown inspection operation')
'@ | Set-Content -LiteralPath $inspector -Encoding utf8NoBOM
    & python -I $inspector versions $projectRoot $version
    & python -I $inspector snapshot $projectRoot (Join-Path $output 'source-tree.json')
    & node --check (Join-Path $projectRoot 'ui/app.js')
    Invoke-ProjectCargo -CargoArgs @('test', '--workspace', '--all-targets', '--locked', '--target', $targetTriple) -Stage 'unit-fixture-tests'
    $receipt.acceptance.unit_and_fixture_tests = 'passed'
    Invoke-ProjectCargo -CargoArgs @('auditable', 'build', '--release', '--locked', '--target', $targetTriple, '-p', 'codaclauda-cli') -Stage 'build-cli'
    $release = Join-Path $target "$targetTriple/release"
    $cli = Join-Path $release 'codaclauda-cli.exe'
    $resources = Join-Path $projectRoot 'dist/bin'
    New-Item -ItemType Directory -Path $resources -Force | Out-Null
    $extras = @(Get-ChildItem -LiteralPath $resources -Force | Where-Object { $_.Name -ne 'codaclauda-cli.exe' -or $_.PSIsContainer })
    if ($extras.Count) { throw 'dist/bin contains unexpected resources. Review them before packaging; this recipe will not silently include or delete them.' }
    Copy-Item -LiteralPath $cli -Destination (Join-Path $resources 'codaclauda-cli.exe') -Force
    & python -I $inspector audit $cli $output
    $notices = Join-Path $projectRoot 'dist/notices'
    New-Item -ItemType Directory -Path $notices -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.md') -Destination $notices -Force
    Invoke-ProjectCargo -CargoArgs @('auditable', 'build', '--manifest-path', 'src-tauri/Cargo.toml', '--release', '--locked', '--target', $targetTriple, '--features', 'custom-protocol') -Stage 'build-desktop'
    $gui = Join-Path $release 'codaclauda.exe'
    & python -I $inspector audit $gui $output
    & python -I (Join-Path $projectRoot 'scripts/notices.py') generate --dependencies (Join-Path $output 'codaclauda-cli.dependencies.json') --dependencies (Join-Path $output 'codaclauda.dependencies.json') --cargo-home $env:CARGO_HOME --output $notices --rust-version $toolchain
    Copy-Item -LiteralPath (Join-Path $notices 'inventory.json') -Destination (Join-Path $output 'notices-inventory.json')
    $bundleStarted = [DateTime]::UtcNow
    $bundleOverride = Join-Path $projectRoot 'local/release-tools/bundle-config.json'
    '{"bundle":{"useLocalToolsDir":true}}' | Set-Content -LiteralPath $bundleOverride -Encoding utf8NoBOM
    # `bundle` packages these binaries without invoking a second Cargo build.
    Invoke-ProjectCargo -CargoArgs @('tauri', 'bundle', '--bundles', 'nsis', '--target', $targetTriple, '--features', 'custom-protocol', '--config', $bundleOverride, '--ci') -Stage 'bundle-nsis'
    $installer = Join-Path $release "bundle/nsis/CodaClauda_${version}_x64-setup.exe"
    if (!(Test-Path -LiteralPath $installer -PathType Leaf) -or (Get-Item -LiteralPath $installer).LastWriteTimeUtc -lt $bundleStarted.AddSeconds(-2)) { throw 'Expected freshly generated x64 NSIS installer was not found.' }
    Copy-Item -LiteralPath $installer -Destination $output
    # The bundler may patch bundle type metadata; audit and hash final bytes.
    & python -I $inspector audit $gui $output
    $extracted = Join-Path $output 'extracted'
    & $sevenZip x $installer "-o$extracted" -y | Out-File -LiteralPath (Join-Path $output 'extract-installer.log') -Encoding utf8
    $payloads = @()
    $extractedPaths = @{}
    foreach ($binary in @(@{name='codaclauda.exe'; source=$gui}, @{name='codaclauda-cli.exe'; source=$cli})) {
        $found = @(Get-ChildItem -LiteralPath $extracted -Recurse -File -Filter $binary.name)
        if ($found.Count -ne 1) { throw "Installer must contain exactly one $($binary.name); found $($found.Count)." }
        $expectedHash = (Get-FileHash -LiteralPath $binary.source -Algorithm SHA256).Hash.ToLowerInvariant()
        $installedHash = (Get-FileHash -LiteralPath $found[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expectedHash -ne $installedHash) { throw "Extracted installer bytes differ for $($binary.name)." }
        $extractedPaths[$binary.name] = $found[0].FullName
        & python -I $inspector audit $found[0].FullName $output
        $payloads += [ordered]@{file=$binary.name; sha256=$installedHash; bytes=$found[0].Length; extraction_matches_build=$true; auditable_metadata=$true}
    }
    $expectedCliLocation = Join-Path (Split-Path -Parent $extractedPaths['codaclauda.exe']) 'bin/codaclauda-cli.exe'
    if (![IO.Path]::GetFullPath($expectedCliLocation).Equals([IO.Path]::GetFullPath($extractedPaths['codaclauda-cli.exe']), [StringComparison]::OrdinalIgnoreCase)) { throw 'CLI resource must be in bin/codaclauda-cli.exe relative to the GUI; this installer would not connect.' }
    & python -I (Join-Path $projectRoot 'scripts/notices.py') verify --extracted $extracted --report (Join-Path $output 'notices-verification.json')
    Compress-Archive -LiteralPath $notices -DestinationPath (Join-Path $output 'third-party-notices.zip')
    & python -I $inspector snapshot $projectRoot (Join-Path $output 'source-tree-after.json')
    if ((Get-FileHash -LiteralPath (Join-Path $output 'source-tree.json')).Hash -ne (Get-FileHash -LiteralPath (Join-Path $output 'source-tree-after.json')).Hash) { throw 'Git-visible source changed during the build. Rebuild a stable source candidate.' }
    if ((& git rev-parse HEAD).Trim() -ne $commit) { throw 'The source commit changed during the build.' }
    if (!$AllowDirty -and @(& git status --porcelain=v1 --untracked-files=all).Count -gt 0) { throw 'A clean build generated non-ignored source changes. Review and commit/ignore appropriate generated files before release.' }
    & python -I $inspector source-zip $projectRoot (Join-Path $output 'source-tree.json') (Join-Path $output 'codaclauda-source.zip')
    Copy-Item -LiteralPath 'Cargo.lock' -Destination (Join-Path $output 'core.Cargo.lock')
    Copy-Item -LiteralPath 'src-tauri/Cargo.lock' -Destination (Join-Path $output 'desktop.Cargo.lock')
    Copy-Item -LiteralPath 'LICENSE', 'PROVENANCE.md', 'THIRD_PARTY_NOTICES.md' -Destination $output
    $receipt.payloads = $payloads
    $receipt.installer = [ordered]@{file=[IO.Path]::GetFileName($installer); sha256=(Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant(); bytes=(Get-Item -LiteralPath $installer).Length; install_mode='currentUser'; webview_install_mode='skip'}
    $receipt.acceptance.package_integrity = 'passed: extracted executable paths/hashes, auditable metadata, and notice file hashes'
    $receipt.result = 'candidate-built'
    $receipt.finished_at = [DateTime]::UtcNow.ToString('o')
    $receipt | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding utf8NoBOM
    Get-ChildItem -LiteralPath $output -File | Where-Object Name -ne 'SHA256SUMS.txt' | Sort-Object Name | ForEach-Object { "{0}  {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name } | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8NoBOM
    Write-Host "Verified packaging candidate: $output"
    Write-Host 'Installation, real provider workflows, Marketplace admission, and publication remain separate acceptance steps.'
} catch {
    if ($null -ne $receipt -and $output) {
        $receipt.result = 'failed'
        $receipt.failure = $_.Exception.Message
        $receipt.finished_at = [DateTime]::UtcNow.ToString('o')
        $receipt | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding utf8NoBOM
    }
    throw
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    Set-Location -LiteralPath $originalLocation
}
