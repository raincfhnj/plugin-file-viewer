import { tool, type Plugin } from '@opencode-ai/plugin'

export const FileViewerPlugin: Plugin = async (ctx) => ({
  tool: {
    open_file_viewer: tool({
      description:
        'Open the git-aware read-only file viewer at an optional path. Scaffold only.',
      args: {
        path: tool.schema.string().optional(),
      },
      async execute() {
        return 'TODO: not yet implemented — see adapters/opencode/README.md'
      },
    }),
  },
})
