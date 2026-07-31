export interface CapabilityCall {
  capability: string;
  method: string;
  qualifiedName: string;
}

interface CapabilityPresentation {
  callDescription: string;
}

const CAPABILITY_CALL_PATTERN = /\b(workspace|git|shell|http|ui|context)\.(\w+)\s*\(/;

const CAPABILITY_PRESENTATIONS: Readonly<Record<string, CapabilityPresentation>> = {
  "workspace.read": { callDescription: "Read workspace files" },
  "workspace.search": { callDescription: "Search workspace" },
  "workspace.edit": { callDescription: "Edit workspace files" },
  "workspace.batch": { callDescription: "Run workspace batch" },
  "workspace.glob": { callDescription: "List matching files" },
  "workspace.list": { callDescription: "List workspace entries" },
  "workspace.stat": { callDescription: "Inspect file metadata" },
  "git.status": { callDescription: "Inspect Git status" },
  "git.diff": { callDescription: "Inspect Git changes" },
  "git.log": { callDescription: "Inspect Git history" },
  "git.add": { callDescription: "Stage Git changes" },
  "git.commit": { callDescription: "Commit Git changes" },
  "git.show": { callDescription: "Inspect a Git object" },
  "git.push": { callDescription: "Push Git changes" },
  "git.tag": { callDescription: "Manage Git tags" },
  "shell.execFile": { callDescription: "Run command" },
  "shell.exec": { callDescription: "Run shell command" },
  "http.request": { callDescription: "Request remote data" },
  "context.get": { callDescription: "Inspect session context" },
};

export function inferCapabilityCall(source: string): CapabilityCall | undefined {
  const match = source.match(CAPABILITY_CALL_PATTERN);
  if (!(match?.[1] && match[2])) {
    return;
  }
  return {
    capability: match[1],
    method: match[2],
    qualifiedName: `${match[1]}.${match[2]}`,
  };
}

export function describeCapabilityCall(call: CapabilityCall | undefined): string | undefined {
  return call ? CAPABILITY_PRESENTATIONS[call.qualifiedName]?.callDescription : undefined;
}
