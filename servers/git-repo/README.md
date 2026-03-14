# @axon-protocol/git-repo-server

AXON Git Repository Server -- manage Git repositories using `child_process.execFile` to run git commands with shell injection protection.

## Tools (10)

| Tool | Description | Capabilities |
|------|-------------|-------------|
| `git_status` | Show working tree status (modified, staged, untracked) | read |
| `git_log` | Show commit history (configurable count, format) | read |
| `git_diff` | Show diffs (staged, unstaged, between commits) | read |
| `git_branch` | List, create, delete, or switch branches | write |
| `git_commit` | Stage files and create a commit | write |
| `git_stash` | Stash, pop, list, or drop stash entries | write |
| `git_remote` | List, add, or remove remotes | write |
| `git_pull` | Pull changes from remote | write |
| `git_push` | Push commits to remote | write |
| `git_blame` | Show line-by-line authorship for a file | read |

## Security

- All git commands scoped to a configurable repository directory
- Uses `child_process.execFile` (not `exec`) to prevent shell injection
- Force push uses `--force-with-lease` and requires explicit configuration
- Large diffs, logs, and blame results stored in OCRS
- `GIT_TERMINAL_PROMPT=0` prevents interactive credential prompts

## Configuration

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `AXON_GIT_REPO` | Repository directory | Current directory |
| `AXON_GIT_ALLOW_FORCE_PUSH` | Allow force push operations | `false` |

## Usage

### MCP Server (stdio)

```bash
AXON_GIT_REPO=/home/user/my-project npx tsx src/mcp-stdio.ts
```

### Programmatic

```typescript
import { launchGitRepoServer } from "@axon-protocol/git-repo-server";

const { server, grm } = await launchGitRepoServer({
  repoDir: "/home/user/my-project",
  allowForcePush: false,
});

console.log(`${server.toolCount} tools ready`);
```

## Development

```bash
npm install
npm run build
npm run dev
```
