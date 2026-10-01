// @ts-check

/** @type {ReturnType<import('electron').Dialog['showMessageBox']> | null} */
let failureDialog = null;

/** @param {string} message @param {Pick<import('electron').Dialog, 'showMessageBox'>} dialog */
const showForkUpdateFailure = (message, dialog) => {
  if (!failureDialog) {
    failureDialog = dialog
      .showMessageBox({ message: `Updating the fork failed: ${message}`, type: 'error' })
      .finally(() => {
        failureDialog = null;
      });
  }
  return failureDialog;
};

/**
 * @param {ReturnType<typeof import('../fork-updater.cjs').createForkUpdater> | null} updater
 * @param {Pick<import('electron').Dialog, 'showMessageBox'>} dialog
 */
const updateForkFromMenu = async (updater, dialog) => {
  if (!updater) {
    return;
  }

  try {
    const status = await updater.applyUpdate();
    if (status.phase === 'error') {
      await showForkUpdateFailure(status.message ?? 'Unknown update error.', dialog);
    }
  } catch (error) {
    void showForkUpdateFailure(error instanceof Error ? error.message : String(error), dialog);
  }
};

module.exports = { showForkUpdateFailure, updateForkFromMenu };
