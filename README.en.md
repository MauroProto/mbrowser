# mbrowser quick start

mbrowser connects DeepSeek Harness to Chrome. The agent works in background tabs. Open the Chrome side panel to see its tabs and pointer while you keep browsing.

1. [Download the extension](https://github.com/MauroProto/mbrowser/releases/download/v3.1.1/mbrowser-extension-3.1.1.zip) and unzip it outside the agent's workspace. In `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the folder with `manifest.json`.
2. With [DeepSeek Harness 0.2.2-rc.1](https://www.deepseek.com/harness/en/), open **Plugins → Install** and paste the bundle URL.

```text
https://github.com/MauroProto/mbrowser/releases/download/v3.1.1/mbrowser-3.1.1.tgz
```

3. In the Harness you want to use, choose the **`/mbrowser`** command. Chrome opens mbrowser and connects.

If you updated the files in the same extension folder, open the mbrowser icon once so Chrome loads the update. Then choose **`/mbrowser`** in Harness.

Use Chrome 120 or later. For the CLI web profile, install the bundle with `dsh plugin --profile web add <bundle-url>` and start `dsh web`. [Harness bundle documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

Open mbrowser from the Chrome toolbar, choose **Activar**, and ask Harness to open `https://example.com` and read its title. Choose **Permitir** when a new site appears. The task continues and the site approval is saved. Choose **Ver** next to an agent tab to see its page and pointer.

**Desactivar** stops control. mbrowser also switches off after about two minutes without browser actions and starts off when Chrome restarts. **Desconectar** clears the connection and its approvals. Selecting an agent tab in Chrome gives you control of that tab. Preview frames stay in Chrome. Harness receives the page content the agent reads, including content from signed-in sites you approve.

[Guía en español](./README.md) · [Architecture](./ARCHITECTURE.md) · [Testing](./TESTING.md)
