import type {
  DiffImageContentRequest,
  DiffImageContentResult,
  DiffSection,
  DiffSectionContentRequest,
} from './types.ts';

export type ReviewContentLoader = {
  loadImageContent: (request: DiffImageContentRequest) => Promise<DiffImageContentResult>;
  loadSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
};
