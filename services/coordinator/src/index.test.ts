import { describe, expect, test } from 'bun:test';
import {
  assessmentStartPayloadSchema,
  createCoordinator,
  handleAssessmentStart,
  reconBrowserPayloadSchema,
  validateFindingPayloadSchema,
} from './index.ts';

describe('services/coordinator :: public surface', () => {
  test('exports createCoordinator factory', () => {
    expect(typeof createCoordinator).toBe('function');
  });

  test('exports handleAssessmentStart', () => {
    expect(typeof handleAssessmentStart).toBe('function');
  });

  test('exports payload schemas', () => {
    expect(assessmentStartPayloadSchema).toBeDefined();
    expect(reconBrowserPayloadSchema).toBeDefined();
    expect(validateFindingPayloadSchema).toBeDefined();
  });
});
