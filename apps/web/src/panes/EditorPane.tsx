import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useFilesStore, fileIsDirty } from '../state/filesStore.js';
import { useFsClient } from '../ws/useFsClient.js';

/**
 * EditorPane — CodeMirror 6 over the open file's buffer, saving through the
 * FS bridge (blueprint: "EditorPane — CodeMirror 6, save-through-the-bridge").
 * An external change never silently overwrites the buffer: a banner offers
 * reload, per the blueprint conflict policy.
 */

export function EditorPane() {
  const file = useFilesStore((state) => state.file);
  const dirty = useFilesStore(fileIsDirty);
  const editBuffer = useFilesStore((state) => state.editBuffer);
  const saveFile = useFilesStore((state) => state.saveFile);
  const reloadFile = useFilesStore((state) => state.reloadFile);
  const closeFile = useFilesStore((state) => state.closeFile);
  const client = useFsClient();
  const editorHost = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastPathRef = useRef<string | null>(null);
  // The editor pushes changes into the store; the store's buffer lands back
  // only when a different file opens (the swap below) — never per keystroke,
  // which would fight the cursor.
  const onEditRef = useRef(editBuffer);
  onEditRef.current = editBuffer;

  useEffect(() => {
    const host = editorHost.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          basicSetup,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onEditRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Swap the document when a different file opens. Runs during render, before
  // paint, so the visible document never lags the store.
  const openPath = file === null ? null : `${file.root}::${file.path}`;
  if (lastPathRef.current !== openPath) {
    lastPathRef.current = openPath;
    const view = viewRef.current;
    if (view !== null && file !== null) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: file.buffer } });
    }
  }

  return (
    <div className="editor" data-testid="editor-pane">
      <div className="editor__bar">
        <span className="editor__path" data-testid="editor-path">
          {file === null ? 'no file open' : `${file.root} · ${file.path}`}
        </span>
        {dirty ? <span className="editor__dirty">unsaved</span> : null}
        {file?.externalChanged ? (
          <span className="editor__external" data-testid="editor-external">
            changed on disk
            <button
              type="button"
              className="editor__reload"
              onClick={() => client !== null && void reloadFile(client)}
            >
              reload
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className="editor__save"
          data-testid="editor-save"
          disabled={file === null || !dirty || file.saving || client === null}
          onClick={() => {
            if (client !== null && file !== null && !file.saving) void saveFile(client);
          }}
        >
          {file?.saving === true ? 'saving…' : 'save'}
        </button>
        <button
          type="button"
          className="editor__close"
          aria-label="close file"
          onClick={closeFile}
        >
          ×
        </button>
      </div>
      {file === null ? (
        <p className="editor__empty" data-testid="editor-empty">
          open a file from the tree to edit it
        </p>
      ) : null}
      <div
        className={file === null ? 'editor__host editor__host--hidden' : 'editor__host'}
        ref={editorHost}
      />
    </div>
  );
}
