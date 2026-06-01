[CmdletBinding()]
param(
  [string]$HostName = "139.196.227.195",
  [string]$User = "root",
  [int]$PostgresLocalPort = 5432,
  [int]$PostgresRemotePort = 5432,
  [int]$RedisLocalPort = 6379,
  [int]$RedisRemotePort = 6379
)

$target = "$User@$HostName"
$postgresForward = "${PostgresLocalPort}:127.0.0.1:${PostgresRemotePort}"
$redisForward = "${RedisLocalPort}:127.0.0.1:${RedisRemotePort}"

Write-Host "Opening SSH tunnel to $target"
Write-Host "PostgreSQL: localhost:$PostgresLocalPort -> server 127.0.0.1:$PostgresRemotePort"
Write-Host "Redis:      localhost:$RedisLocalPort -> server 127.0.0.1:$RedisRemotePort"
Write-Host "Keep this PowerShell window open while running local migrate/seed/dev commands."

ssh -N -L $postgresForward -L $redisForward $target
