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
