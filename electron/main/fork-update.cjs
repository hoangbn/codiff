// @ts-check

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
      await dialog.showMessageBox({
        message: `Updating the fork failed: ${status.message ?? 'Unknown update error.'}`,
        type: 'error',
      });
    }
  } catch (error) {
    void dialog.showMessageBox({
      message: `Updating the fork failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      type: 'error',
    });
  }
};

module.exports = { updateForkFromMenu };
