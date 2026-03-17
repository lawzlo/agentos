export const BUILTIN_SKILLS = [
  {
    name: "slack-send-message",
    surfaceScope: "browser",
    triggerTerms: ["slack send message", "send slack message"],
    anchors: [{ text: "Slack", role: "workspace" }, { text: "Send", role: "button" }],
    actionTemplate: [],
    successCriteria: [{ type: "textVisible", value: "Message sent" }],
    recoveryHints: ["workspace switch", "composer not focused"],
    metadata: { pack: "slack", builtin: true }
  },
  {
    name: "wechat-send-message",
    surfaceScope: "desktop",
    triggerTerms: ["wechat send message", "send wechat message", "微信 发消息"],
    anchors: [{ text: "微信", role: "app" }, { text: "发送", role: "button" }],
    actionTemplate: [],
    successCriteria: [{ type: "textVisible", value: "发送" }],
    recoveryHints: ["contact not focused", "search box hidden"],
    metadata: { pack: "wechat", builtin: true }
  },
  {
    name: "boss-open-candidate",
    surfaceScope: "browser",
    triggerTerms: ["boss open candidate", "boss candidate detail", "boss直聘 候选人"],
    anchors: [{ text: "BOSS直聘", role: "workspace" }],
    actionTemplate: [],
    successCriteria: [{ type: "textVisible", value: "在线沟通" }],
    recoveryHints: ["search filters changed", "candidate card moved"],
    metadata: { pack: "boss", builtin: true }
  },
  {
    name: "browser-download-file",
    surfaceScope: "browser",
    triggerTerms: ["download file", "download attachment", "save file from browser"],
    anchors: [{ text: "Download", role: "button" }],
    actionTemplate: [
      {
        label: "Open target page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Download file",
        surface: "browser",
        action: "download",
        params: {
          targetQuery: "{{downloadTarget}}",
          fileName: "{{downloadFileName}}"
        },
        saveAs: "download",
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "resultSaved", value: "download" }],
    recoveryHints: ["download link moved", "browser blocked the download"],
    metadata: {
      pack: "files",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://example.com" },
        { key: "downloadTarget", defaultValue: "Download" },
        { key: "downloadFileName", defaultValue: "downloaded-file" }
      ]
    }
  },
  {
    name: "browser-upload-file",
    surfaceScope: "browser",
    triggerTerms: ["upload file", "attach file", "browser upload file"],
    anchors: [{ text: "Upload", role: "button" }],
    actionTemplate: [
      {
        label: "Open target page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Upload file",
        surface: "browser",
        action: "upload",
        params: {
          targetQuery: "{{uploadTarget}}",
          path: "{{uploadPath}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "textVisible", value: "Uploaded" }],
    recoveryHints: ["file input hidden", "upload target moved"],
    metadata: {
      pack: "files",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://example.com" },
        { key: "uploadTarget", defaultValue: "Upload" },
        { key: "uploadPath", defaultValue: "workspace/sample.txt" }
      ]
    }
  },
  {
    name: "browser-edit-document",
    surfaceScope: "browser",
    triggerTerms: ["edit document", "update document", "browser edit document"],
    anchors: [{ text: "Document", role: "document" }, { text: "Save", role: "button" }],
    actionTemplate: [
      {
        label: "Open document page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Update document text",
        surface: "browser",
        action: "typeIntoTarget",
        params: {
          targetQuery: "{{documentTarget}}",
          text: "{{documentText}}",
          clear: true
        },
        checkpoint: false
      },
      {
        label: "Save document",
        surface: "browser",
        action: "clickTarget",
        params: {
          targetQuery: "{{saveTarget}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "textVisible", value: "Saved" }],
    recoveryHints: ["document editor changed", "save button moved"],
    metadata: {
      pack: "docs",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://example.com" },
        { key: "documentTarget", defaultValue: "Document editor" },
        { key: "documentText", defaultValue: "Updated document text" },
        { key: "saveTarget", defaultValue: "Save document" }
      ]
    }
  },
  {
    name: "google-drive-upload-file",
    surfaceScope: "browser",
    triggerTerms: ["google drive upload file", "upload file to google drive", "drive upload"],
    anchors: [{ text: "Google Drive", role: "workspace" }, { text: "Upload to Drive", role: "button" }],
    actionTemplate: [
      {
        label: "Open Google Drive page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Upload to Google Drive",
        surface: "browser",
        action: "upload",
        params: {
          targetQuery: "{{uploadTarget}}",
          path: "{{uploadPath}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "textVisible", value: "Drive uploaded" }],
    recoveryHints: ["drive upload target moved", "drive upload input hidden"],
    metadata: {
      pack: "google-drive",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://drive.google.com" },
        { key: "uploadTarget", defaultValue: "Upload to Drive" },
        { key: "uploadPath", defaultValue: "workspace/sample.txt" }
      ]
    }
  },
  {
    name: "google-drive-download-file",
    surfaceScope: "browser",
    triggerTerms: ["google drive download file", "download file from google drive", "drive download"],
    anchors: [{ text: "Google Drive", role: "workspace" }, { text: "Download shared file", role: "link" }],
    actionTemplate: [
      {
        label: "Open Google Drive page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Download from Google Drive",
        surface: "browser",
        action: "download",
        params: {
          targetQuery: "{{downloadTarget}}",
          fileName: "{{downloadFileName}}"
        },
        saveAs: "download",
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "resultSaved", value: "download" }],
    recoveryHints: ["drive download target moved", "download link unavailable"],
    metadata: {
      pack: "google-drive",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://drive.google.com" },
        { key: "downloadTarget", defaultValue: "Download shared file" },
        { key: "downloadFileName", defaultValue: "drive-shared-file.txt" }
      ]
    }
  },
  {
    name: "google-docs-edit-document",
    surfaceScope: "browser",
    triggerTerms: ["google docs edit document", "edit google doc", "update google docs document"],
    anchors: [{ text: "Google Docs", role: "workspace" }, { text: "Google Docs editor", role: "document" }],
    actionTemplate: [
      {
        label: "Open Google Docs page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Update Google Docs text",
        surface: "browser",
        action: "typeIntoTarget",
        params: {
          targetQuery: "{{documentTarget}}",
          text: "{{documentText}}",
          clear: true
        },
        checkpoint: false
      },
      {
        label: "Save Google Docs document",
        surface: "browser",
        action: "clickTarget",
        params: {
          targetQuery: "{{saveTarget}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "textVisible", value: "Saved in Google Docs" }],
    recoveryHints: ["google docs editor changed", "save button moved"],
    metadata: {
      pack: "google-docs",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://docs.google.com" },
        { key: "documentTarget", defaultValue: "Google Docs editor" },
        { key: "documentText", defaultValue: "Updated Google Docs text" },
        { key: "saveTarget", defaultValue: "Save Google Doc" }
      ]
    }
  },
  {
    name: "feishu-docs-edit-document",
    surfaceScope: "browser",
    triggerTerms: ["feishu docs edit document", "edit feishu doc", "飞书文档 编辑"],
    anchors: [{ text: "Feishu Docs", role: "workspace" }, { text: "飞书文档编辑区", role: "document" }],
    actionTemplate: [
      {
        label: "Open Feishu Docs page",
        surface: "browser",
        action: "goto",
        params: {
          url: "{{startUrl}}"
        },
        checkpoint: false
      },
      {
        label: "Update Feishu document text",
        surface: "browser",
        action: "typeIntoTarget",
        params: {
          targetQuery: "{{documentTarget}}",
          text: "{{documentText}}",
          clear: true
        },
        checkpoint: false
      },
      {
        label: "Save Feishu document",
        surface: "browser",
        action: "clickTarget",
        params: {
          targetQuery: "{{saveTarget}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "textVisible", value: "已保存到飞书" }],
    recoveryHints: ["feishu editor changed", "save button moved"],
    metadata: {
      pack: "feishu-docs",
      builtin: true,
      skillInputs: [
        { key: "startUrl", defaultValue: "https://feishu.cn/docx" },
        { key: "documentTarget", defaultValue: "飞书文档编辑区" },
        { key: "documentText", defaultValue: "更新后的飞书文档内容" },
        { key: "saveTarget", defaultValue: "保存到飞书" }
      ]
    }
  },
  {
    name: "local-organize-file",
    surfaceScope: "desktop",
    triggerTerms: ["organize file", "move file", "sort downloaded file"],
    anchors: [{ text: "file", role: "document" }],
    actionTemplate: [
      {
        label: "Move file",
        surface: "desktop",
        action: "moveFile",
        params: {
          from: "{{moveFileFrom}}",
          to: "{{moveFileTo}}"
        },
        checkpoint: false
      }
    ],
    successCriteria: [{ type: "fileExists", value: "{{moveFileTo}}" }],
    recoveryHints: ["source file missing", "destination path invalid"],
    metadata: {
      pack: "files",
      builtin: true,
      skillInputs: [
        { key: "moveFileFrom", defaultValue: "downloads/file.txt" },
        { key: "moveFileTo", defaultValue: "organized/file.txt" }
      ]
    }
  }
];
