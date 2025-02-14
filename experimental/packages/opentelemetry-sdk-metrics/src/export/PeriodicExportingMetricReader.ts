/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as api from '@opentelemetry/api';
import {
  ExportResultCode,
  globalErrorHandler,
  unrefTimer
} from '@opentelemetry/core';
import { MetricReader } from './MetricReader';
import { AggregationTemporality } from './AggregationTemporality';
import { InstrumentType } from '../InstrumentDescriptor';
import { PushMetricExporter } from './MetricExporter';
import { callWithTimeout, TimeoutError } from '../utils';
import { Aggregation } from '../view/Aggregation';
import { AggregationSelector } from './AggregationSelector';

export type PeriodicExportingMetricReaderOptions = {
  /**
   * Aggregation selector based on metric instrument types. If no views are
   * configured for a metric instrument, a per-metric-reader aggregation is
   * selected with this selector.
   */
  aggregationSelector?: AggregationSelector;
  /**
   * The backing exporter for the metric reader.
   */
  exporter: PushMetricExporter;
  /**
   * An internal milliseconds for the metric reader to initiate metric
   * collection.
   */
  exportIntervalMillis?: number;
  /**
   * Milliseconds for the async observable callback to timeout.
   */
  exportTimeoutMillis?: number;
};

const DEFAULT_AGGREGATION_SELECTOR: AggregationSelector = Aggregation.Default;

/**
 * {@link MetricReader} which collects metrics based on a user-configurable time interval, and passes the metrics to
 * the configured {@link MetricExporter}
 */
export class PeriodicExportingMetricReader extends MetricReader {
  private _interval?: ReturnType<typeof setInterval>;
  private _exporter: PushMetricExporter;
  private readonly _exportInterval: number;
  private readonly _exportTimeout: number;
  private readonly _aggregationSelector: AggregationSelector;

  constructor(options: PeriodicExportingMetricReaderOptions) {
    super();

    if (options.exportIntervalMillis !== undefined && options.exportIntervalMillis <= 0) {
      throw Error('exportIntervalMillis must be greater than 0');
    }

    if (options.exportTimeoutMillis !== undefined && options.exportTimeoutMillis <= 0) {
      throw Error('exportTimeoutMillis must be greater than 0');
    }

    if (options.exportTimeoutMillis !== undefined &&
      options.exportIntervalMillis !== undefined &&
      options.exportIntervalMillis < options.exportTimeoutMillis) {
      throw Error('exportIntervalMillis must be greater than or equal to exportTimeoutMillis');
    }

    this._exportInterval = options.exportIntervalMillis ?? 60000;
    this._exportTimeout = options.exportTimeoutMillis ?? 30000;
    this._exporter = options.exporter;
    this._aggregationSelector = options.aggregationSelector ?? DEFAULT_AGGREGATION_SELECTOR;
  }

  private async _runOnce(): Promise<void> {
    const { resourceMetrics, errors } = await this.collect({});

    if (errors.length > 0) {
      api.diag.error('PeriodicExportingMetricReader: metrics collection errors', ...errors);
    }

    return new Promise((resolve, reject) => {
      this._exporter.export(resourceMetrics, result => {
        if (result.code !== ExportResultCode.SUCCESS) {
          reject(
            result.error ??
              new Error(
                `PeriodicExportingMetricReader: metrics export failed (error ${result.error})`
              )
          );
        } else {
          resolve();
        }
      });
    });
  }

  protected override onInitialized(): void {
    // start running the interval as soon as this reader is initialized and keep handle for shutdown.
    this._interval = setInterval(async () => {
      try {
        await callWithTimeout(this._runOnce(), this._exportTimeout);
      } catch (err) {
        if (err instanceof TimeoutError) {
          api.diag.error('Export took longer than %s milliseconds and timed out.', this._exportTimeout);
          return;
        }

        globalErrorHandler(err);
      }
    }, this._exportInterval);
    unrefTimer(this._interval);
  }

  protected async onForceFlush(): Promise<void> {
    await this._exporter.forceFlush();
  }

  protected async onShutdown(): Promise<void> {
    if (this._interval) {
      clearInterval(this._interval);
    }

    await this._exporter.shutdown();
  }

  /**
   * @inheritdoc
   */
  selectAggregation(instrumentType: InstrumentType): Aggregation {
    return this._aggregationSelector(instrumentType);
  }

  /**
   * @inheritdoc
   */
  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return this._exporter.selectAggregationTemporality(instrumentType);
  }
}
