# 出 exe（2026-11-08 扫尾批 4b）
#
#   powershell -ExecutionPolicy Bypass -File .\build.ps1
#
# 版本号取 `git describe --tags --always`；不是 git 仓库 / 没有提交时退回 dev。
# 图标已由 rsrc.syso 嵌入（不重生成，见 assets/ 与 gen-gray-icon/）。
$ErrorActionPreference = "Stop"

Push-Location $PSScriptRoot
try {
    $version = git describe --tags --always 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
        $version = "dev"
    }
    $version = $version.Trim()

    go build -ldflags "-H windowsgui -X main.version=$version" -o lifediary-shell.exe .
    if ($LASTEXITCODE -ne 0) { throw "go build 失败（exit $LASTEXITCODE）" }

    Write-Host "已生成 desktop/lifediary-shell.exe（版本 $version）"
} finally {
    Pop-Location
}
