import {
  DataSourceInstanceSettings,
  DataSourceApi,
  DataQueryRequest,
  DataQueryResponse,
  CircularDataFrame,
  FieldType,
  LogLevel,
} from '@grafana/data';
import { BackendSrvRequest } from '@grafana/runtime';

import { merge, Observable } from 'rxjs';
import { FlowhookDataSourceOptions, FlowhookQuery } from './types';
import { getBackendSrv } from '@grafana/runtime';

import { Client } from '@stomp/stompjs';
export const DEFAULT_MAX_LINES = 1000;

export class DataSource extends DataSourceApi<FlowhookQuery, FlowhookDataSourceOptions> {
  baseUrl: string | undefined;

  /** @ngInject */
  constructor(private instanceSettings: DataSourceInstanceSettings<FlowhookDataSourceOptions>) {
    super(instanceSettings);
    this.baseUrl = instanceSettings.url;
  }

  _request(apiUrl: string, options?: Partial<BackendSrvRequest>): Observable<Record<string, any>> {
    const baseUrl = this.instanceSettings.url;
    const params = '';
    const url = `${baseUrl}${apiUrl}${params.length ? `?${params}` : ''}`;
    const req = {
      ...options,
      url,
    };
    console.log('request', url, req);
    return getBackendSrv().fetch<Record<string, any>>(req);
  }

  query(request: DataQueryRequest<FlowhookQuery>): Promise<DataQueryResponse> | Observable<DataQueryResponse> {
    const streams: Array<Observable<DataQueryResponse>> = [];

    // Start streams and prepare queries
    for (const target of request.targets) {
      if (target.hide) {
        continue;
      }
      streams.push(this.runLogsStream(target, target, request));
    }

    return merge(...streams);
  }

  runLogsStream(
    target: any,
    query: FlowhookQuery,
    req: DataQueryRequest<FlowhookQuery>
  ): Observable<DataQueryResponse> {
    return new Observable<DataQueryResponse>(subscriber => {
      const maxDataPoints = req.maxDataPoints || 1000;

      const data = new CircularDataFrame({
        append: 'tail',
        capacity: maxDataPoints,
      });
      data.refId = target.refId;
      data.name = target.alias || 'Logs ' + target.refId;
      data.addField({ name: 'line', type: FieldType.string }).labels = { cat: '', ident: '' };
      data.addField({ name: 'event', type: FieldType.string }).labels = { cat: '', ident: '' };
      data.addField({ name: 'time', type: FieldType.time });
      data.addField({ name: 'cat', type: FieldType.string });
      data.addField({ name: 'ident', type: FieldType.string });
      data.addField({ name: 'status', type: FieldType.string });
      data.addField({ name: 'message', type: FieldType.string });
      data.addField({ name: 'meta', type: FieldType.other });

      // log level colouring
      data.addField({ name: 'level', type: FieldType.string });
      // unique id for dedup
      data.addField({ name: 'id', type: FieldType.string });
      data.meta = {
        preferredVisualisationType: 'logs',
      };

      console.log('q', query);
      const streamId = `logs-${req.panelId}-${target.refId}`;

      // -----------------------

      let stompClient: Client;
      let ds: DataSource = this;

      const stompConfig = {
        // defaults
        connectHeaders: {
          login: `${ds.instanceSettings.jsonData.brokerUsername}`,
          passcode: `${ds.instanceSettings.jsonData.brokerPassword}`
        },

        // Broker URL, should start with ws:// or wss:// - adjust for your broker setup
        //brokerURL: 'wss://flowhook.herokuapp.com/ws',
        brokerURL: ds.instanceSettings.jsonData.brokerUrl || 'wss://flowhook.herokuapp.com/ws',
        
        // Keep it off for production, it can be quit verbose
        // Skip this key to disable
        debug: function(str: string) {
          console.log('STOMP: ' + str);
        },

        // If disconnected, it will retry after 200ms
        reconnectDelay: 200,

        // Subscriptions should be done inside onConnect as those need to reinstated when the broker reconnects
        onConnect: function(frame: any) {
          stompClient.subscribe(`/topic/${ds.instanceSettings.jsonData.flowhook}`, function(message) {
            const payload = JSON.parse(message.body);
            ds.appendData(data, payload);

            subscriber.next({
              data: [data],
              key: streamId,
            });
          });
        }
      };

      // Create an instance
      stompClient = new Client(stompConfig);
      stompClient.activate();
    });
  }

  appendData(data: CircularDataFrame, t: any) {
    data.add({
      time: t.created ? t.created : new Date(t.time),
      line: `[${t.category}][${t.ident}] ${t.event}`,
      event: t.event,
      cat: t.category,
      ident: t.ident,
      status: t.status,
      level: this.getLogLevel(t.status),
      message: t.message,
      id: t.uuid,
      meta: t.messagePropertySection?.length > 0 ? JSON.stringify(t.messagePropertySection) : [],
    });

    data.meta = {
      notices: [
        {
          severity: t.status,
          text: t.status,
        },
      ],
      preferredVisualisationType: 'logs',
    };
  }

  getLogLevel(status: string): LogLevel {
    switch (status) {
      case 'error':
        return LogLevel.error;
      case 'warn':
        return LogLevel.warn;
      case 'success':
        return LogLevel.info;
      case 'info':
        return LogLevel.notice;
    }

    return LogLevel.unknown;
  }

  async testDatasource() {
    // Implement a health check for your data source.
    return {
      status: 'success',
      message: 'Success',
    };
  }
}