import "./WorkflowEditor.css";
import { ReactFlowProvider } from "@xyflow/react";
import { Editor } from "./WorkflowEditor/Editor.tsx";

export function WorkflowEditor({ wfKey }: { wfKey: string }) {
  return (
    <ReactFlowProvider>
      <Editor wfKey={wfKey} />
    </ReactFlowProvider>
  );
}
