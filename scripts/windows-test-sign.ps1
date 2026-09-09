param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$subject = 'CN=AuraPunk IDE Test'
$store = 'Cert:\LocalMachine\My'

$certificate = Get-ChildItem $store |
  Where-Object { $_.Subject -eq $subject -and $_.HasPrivateKey } |
  Select-Object -First 1

if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -CertStoreLocation $store `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(2)
}

# Authenticode validates the certificate chain while signing. Trust the
# development certificate locally so the test installer can be signed on the
# self-hosted runner without pretending to be a production certificate.
$temporaryCertificate = Join-Path $env:TEMP 'aurapunk-ide-test-signing.cer'
Export-Certificate -Cert $certificate -FilePath $temporaryCertificate -Type CERT | Out-Null
foreach ($trustedStore in @(
    'Cert:\LocalMachine\Root',
    'Cert:\LocalMachine\TrustedPublisher'
  )) {
  $alreadyTrusted = Get-ChildItem $trustedStore |
    Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }
  if (-not $alreadyTrusted) {
    Import-Certificate -FilePath $temporaryCertificate -CertStoreLocation $trustedStore |
      Out-Null
  }
}
Remove-Item $temporaryCertificate -Force -ErrorAction SilentlyContinue

$signature = Set-AuthenticodeSignature `
  -FilePath $Path `
  -Certificate $certificate `
  -HashAlgorithm SHA256

if ($signature.Status -ne 'Valid') {
  throw "Self-signing failed: $($signature.Status) $($signature.StatusMessage)"
}

$verification = Get-AuthenticodeSignature -FilePath $Path
if ($verification.Status -ne 'Valid') {
  throw "Self-signature verification failed: $($verification.Status) $($verification.StatusMessage)"
}

Write-Output "Self-signed test executable: $Path"
Write-Output "Certificate thumbprint: $($certificate.Thumbprint)"
