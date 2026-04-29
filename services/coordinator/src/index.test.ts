import { describe, expect, test } from 'bun:test';
import {
  assessmentStartPayloadSchema,
  createCoordinator,
  handleAssessmentStart,
  publishReconChildJobs,
  reconPlaceholderHandler,
  reconPlaceholderPayloadSchema,
} from './index.ts';

describe('services/coordinator :: public surface', () => {
  test('exports createCoordinator factory', () => {
    expect(typeof createCoordinator).toBe('function');
  });

  test('exports handleAssessmentStart', () => {
    expect(typeof handleAssessmentStart).toBe('function');
  });

  test('exports publishReconChildJobs', () => {
    expect(typeof publishReconChildJobs).toBe('function');
  });

  test('exports reconPlaceholderHandler', () => {
    expect(typeof reconPlaceholderHandler).toBe('function');
  });

  test('exports payload schemas', () => {
    expect(assessmentStartPayloadSchema).toBeDefined();
    expect(reconPlaceholderPayloadSchema).toBeDefined();
  });
});
