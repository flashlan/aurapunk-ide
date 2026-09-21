# Microsoft Store

AuraPunk is submitted as a native MSIX upload package. The Store re-signs that
package after certification, so no commercial code-signing certificate is used
or stored by this repository.

## One-time Partner Center setup

Reserve **Aurapunk IDE** in Partner Center, then copy the exact case-sensitive
values from **Product management → Identity details** into GitHub Actions
Variables:

- `MS_STORE_IDENTITY_NAME`
- `MS_STORE_PUBLISHER`
- `MS_STORE_PUBLISHER_DISPLAY_NAME`
- `MS_STORE_APPLICATION_ID` (normally `App`)
- `MS_STORE_PRODUCT_ID`

To enable the optional publication step, create these GitHub Actions Secrets
for the Partner Center Entra application:

- `AZURE_AD_TENANT_ID`
- `AZURE_AD_APPLICATION_CLIENT_ID`
- `AZURE_AD_APPLICATION_SECRET`
- `SELLER_ID`

## Build and submit

Run **Microsoft Store package** from the Actions page, selecting the release
tag (for example `v0.3.22`). With `publish` disabled, it produces an unsigned
`Aurapunk-IDE.msixupload` artifact for review. With `publish` enabled, it sends
that same artifact to Partner Center using the configured credentials.

The package contains the Tauri IDE window, embedded web frontend, MCP, TUI,
review and Telegram binaries, plus the Fast Jev plugin. It intentionally does
not bundle Docker images or Android artifacts.
