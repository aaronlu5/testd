import type { JsonValue, ValidationIssue } from '@test-platform/contracts';
import { PlatformError, type TargetPolicy } from '@test-platform/core';
import {
  BLOB_DOWNLOAD_STEP_TYPE,
  BLOB_UPLOAD_STEP_TYPE,
  planBlobDownload,
  planBlobUploads,
  type BlobDownloadConfig,
  type BlobUploadConfig,
} from './blob.js';
import { HTTP_REQUEST_STEP_TYPE, planHttpRequest, type HttpRequestConfig } from './http-request.js';
import {
  SERVICE_BUS_SEND_STEP_TYPE,
  planServiceBusSend,
  type ServiceBusSendConfig,
} from './service-bus.js';
import {
  SQL_EXECUTE_STEP_TYPE,
  SQL_QUERY_STEP_TYPE,
  planSqlExecute,
  planSqlQuery,
  type SqlExecuteConfig,
  type SqlQueryConfig,
} from './sql.js';
import {
  WAIT_FOR_CONDITION_STEP_TYPE,
  planWaitForCondition,
  type WaitForConditionConfig,
} from './wait-for-condition.js';

export {
  BLOB_DOWNLOAD_STEP_TYPE,
  BLOB_UPLOAD_STEP_TYPE,
  blobDownloadStep,
  blobUploadStep,
  type BlobDownloadConfig,
  type BlobUploadConfig,
} from './blob.js';
export { HTTP_REQUEST_STEP_TYPE, httpRequestStep, type HttpRequestConfig } from './http-request.js';
export {
  SERVICE_BUS_SEND_STEP_TYPE,
  serviceBusRetryAllowed,
  serviceBusSendStep,
  type ServiceBusSendConfig,
} from './service-bus.js';
export {
  SQL_EXECUTE_STEP_TYPE,
  SQL_QUERY_STEP_TYPE,
  sqlExecuteStep,
  sqlQueryStep,
  type SqlExecuteConfig,
  type SqlQueryConfig,
} from './sql.js';
export {
  WAIT_FOR_CONDITION_STEP_TYPE,
  WAIT_LIMITS,
  waitForConditionStep,
  type WaitForConditionConfig,
} from './wait-for-condition.js';

export const TARGET_STEP_TYPES: readonly string[] = [
  HTTP_REQUEST_STEP_TYPE,
  BLOB_UPLOAD_STEP_TYPE,
  BLOB_DOWNLOAD_STEP_TYPE,
  SERVICE_BUS_SEND_STEP_TYPE,
  SQL_QUERY_STEP_TYPE,
  SQL_EXECUTE_STEP_TYPE,
  WAIT_FOR_CONDITION_STEP_TYPE,
];

/**
 * Checks fully literal parameters of a target Step against the Environment policy, so a Test
 * that could never run is rejected when it is saved or launched rather than inside the worker.
 * Returns no issue for other Step types. Callers must not pass parameters containing expressions.
 */
export const checkTargetStepPolicy = (
  type: string,
  parameters: JsonValue,
  policy: TargetPolicy,
): ValidationIssue[] => {
  const run = (plan: () => void): ValidationIssue[] => {
    try {
      plan();
      return [];
    } catch (error) {
      if (error instanceof PlatformError)
        return [{ path: '', message: error.message, keyword: 'target-policy' }];
      throw error;
    }
  };
  const config = parameters as never;
  switch (type) {
    case HTTP_REQUEST_STEP_TYPE:
      return run(() => planHttpRequest(config as HttpRequestConfig, policy));
    case BLOB_UPLOAD_STEP_TYPE:
      return run(() => planBlobUploads(config as BlobUploadConfig, policy));
    case BLOB_DOWNLOAD_STEP_TYPE:
      return run(() => planBlobDownload(config as BlobDownloadConfig, policy));
    case SERVICE_BUS_SEND_STEP_TYPE:
      return run(() => planServiceBusSend(config as ServiceBusSendConfig, policy));
    case SQL_QUERY_STEP_TYPE:
      return run(() => planSqlQuery(config as SqlQueryConfig, policy));
    case SQL_EXECUTE_STEP_TYPE:
      return run(() => planSqlExecute(config as SqlExecuteConfig, policy));
    case WAIT_FOR_CONDITION_STEP_TYPE:
      return run(() => planWaitForCondition(config as WaitForConditionConfig, policy));
    default:
      return [];
  }
};
