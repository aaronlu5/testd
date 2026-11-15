import { StepRegistry } from '../registry.js';
import { assertStep } from './assert.js';
import { breakpointStep } from './breakpoint.js';
import { delayStep } from './delay.js';
import { transformJsonStep } from './transform-json.js';
import {
  blobDownloadStep,
  blobUploadStep,
  httpRequestStep,
  serviceBusSendStep,
  sqlExecuteStep,
  sqlQueryStep,
  waitForConditionStep,
} from '../targets/index.js';

export {
  assertStep,
  ASSERT_OPERATORS,
  deepEqual,
  type AssertConfig,
  type AssertOperator,
} from './assert.js';
export { breakpointOutput, breakpointStep } from './breakpoint.js';
export { delayStep, MAX_DELAY_SECONDS, type DelayConfig } from './delay.js';
export { transformJsonStep, type TransformConfig } from './transform-json.js';

/**
 * Every built-in Step. Target Steps reach Azure only through the worker-supplied clients in
 * their execution context, so registering them pulls in no SDK.
 */
export const createBuiltInRegistry = (): StepRegistry =>
  new StepRegistry()
    .register(delayStep)
    .register(transformJsonStep)
    .register(assertStep)
    .register(breakpointStep)
    .register(httpRequestStep)
    .register(blobUploadStep)
    .register(blobDownloadStep)
    .register(serviceBusSendStep)
    .register(sqlQueryStep)
    .register(sqlExecuteStep)
    .register(waitForConditionStep);
