// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { NotebookDocument, NotebookEditor, workspace, WorkspaceEdit, window, NotebookCell } from 'vscode';
import { createDeferred, isPromise } from '../../../common/utils/async';
import { noop } from '../../../common/utils/misc';

/**
 * Use this class to perform updates on all cells.
 * We cannot update cells in parallel, this could result in data loss.
 * E.g. assume we update execution order, while that's going on, assume we update the output (as output comes back from jupyter).
 * At this point, VSC is still updating the execution order & we then update the output.
 * Depending on the sequence its possible for some of the updates to get lost.
 *
 * Excellent example:
 * Assume we perform the following updates without awaiting on the promise.
 * Without awaiting, its very easy to replicate issues where the output is never displayed.
 * - We update execution count
 * - We update output
 * - We update status after completion
 */
const pendingCellUpdates = new WeakMap<NotebookDocument | NotebookCell, Promise<unknown>>();

export async function chainWithPendingUpdates(
    documentOrCell: NotebookDocument | NotebookCell,
    update: (edit: WorkspaceEdit) => void | Promise<void>
): Promise<boolean> {
    const notebook = 'notebook' in documentOrCell ? documentOrCell.notebook : documentOrCell;
    if (notebook.isClosed) {
        return true;
    }
    const pendingUpdates = pendingCellUpdates.has(notebook)
        ? pendingCellUpdates.get(documentOrCell)!
        : Promise.resolve();
    const deferred = createDeferred<boolean>();
    const aggregatedPromise = pendingUpdates
        // We need to ensure the update operation gets invoked after previous updates have been completed.
        // This way, the callback making references to cell metadata will have the latest information.
        // Even if previous update fails, we should not fail this current update.
        .finally(async () => {
            const edit = new WorkspaceEdit();
            const result = update(edit);
            if (isPromise(result)) {
                await result;
            }
            if (edit.size === 0) {
                return;
            }
            await workspace.applyEdit(edit).then(
                (result) => deferred.resolve(result),
                (ex) => deferred.reject(ex)
            );
        })
        .catch(noop);
    pendingCellUpdates.set(documentOrCell, aggregatedPromise);
    return deferred.promise;
}

export function clearPendingChainedUpdatesForTests() {
    const editor: NotebookEditor | undefined = window.activeNotebookEditor;
    if (editor?.document) {
        pendingCellUpdates.delete(editor.document);
        editor.document.getCells().forEach((cell) => pendingCellUpdates.delete(cell));
    }
}
