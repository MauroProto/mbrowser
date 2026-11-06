# mbrowser quick start

mbrowser connects DeepSeek Harness to Chrome. The agent uses background tabs, and Chrome’s side panel shows the tabs it is using and a local preview with its pointer.

1. With **DeepSeek Harness 0.2.2-rc.1**, open **Plugins → Install**. Paste the bundle URL below, install it, and enable **mbrowser**.
2. Download and unzip the Chrome extension into a folder outside the agent’s workspace. In `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the folder containing `manifest.json`. [Download the extension](https://github.com/MauroProto/mbrowser/releases/download/v3.0.0/mbrowser-extension-3.0.0.zip)
3. From the extension icon, choose **Configurar autorización**. In Harness, ask for an mbrowser pairing code. Add a site such as `https://example.com`, paste the code, review the scope, and choose **Autorizar y conectar**.
4. Ask Harness to open that site with mbrowser and read its title. In Chrome, choose **Ver actividad del agente** from the extension popup to open the activity panel. Once the agent uses its tab, choose **Ver vista previa**.

```text
https://github.com/MauroProto/mbrowser/releases/download/v3.0.0/mbrowser-3.0.0.tgz
```

Use **Chrome 120 or later**. For the CLI web profile, use `dsh plugin --profile web add <bundle-url>`. When upgrading from mbrowser 2, update both parts and pair again. [Harness bundle documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)

Selecting an agent tab gives you control of that tab. Switch back to your own tab before asking the agent to continue. You can pause, resume, or revoke the grant from the extension. Preview frames are rendered locally in Chrome. Content returned by agent tools is visible to Harness.

[Spanish guide and troubleshooting](./README.md)
