/**
 * @license
 * Copyright 2023 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { CronJob } from 'cron';
import clone from 'clone-deep';
import xlsx from 'xlsx';
import debug from 'debug';
import jp from 'json-pointer';
import ksuid from 'ksuid';
import moment from 'moment';

// Import type { Job } from '@oada/jobs';
import type { JsonObject, OADAClient } from '@oada/client';
import { AssumeState, ChangeType, ListWatch } from '@oada/list-lib';
import type EmailConfig from '@oada/types/trellis/service/abalonemail/config/email.js';
import type Job from '@oada/types/oada/service/job.js';
import type Tree from '@oada/types/oada/tree/v1.js';

import type { Service } from './Service.js';
import { tree } from './tree.js';
// Const error = debug('oada-jobs:connection:error');
const info = debug('oada-jobs:connection:info');
// Const warn = debug('oada-jobs:connection:warn');
const trace = debug('oada-jobs:connection:trace');

const EMAIL_SVC = 'abalonemail';

export interface ReportConstructor {
  name: string;
  service: Service;
  frequency: string;
  email: EmailConfigSetup;
  reportConfig: ReportConfig;
  filter?: (job: Job) => boolean;
  type?: string;
  sendEmpty?: boolean;
}

export class Report {
  name: string;
  email: EmailConfigSetup;
  reportConfig: ReportConfig;
  frequency: string;
  service: Service;
  oada: OADAClient;
  mailer: CronJob;
  path: string;
  lastCron: string;
  sendEmpty?: boolean;
  type: string | string[] | undefined;
  listWatchFailures?: ListWatch;
  listWatchSuccesses?: ListWatch;
  filter?: (job: Job) => boolean;

  /**
   * @param name The name of the report
   * @param reportConfig The configuration used to derive CSV rows from the jobs list.
   * @param service The `Service` which the watch is operating under
   * @param frequency A cron-like string describing the frequency of the emailer.
   * @param email A callback used to generate the email job
   * @param type The subservice type to report on
   * @param filter filter function for report entries
   * @param sendEmpty configure whether empty reports should be sent (default=false)
   * /
   */
  constructor(rc: ReportConstructor) {
    this.name = rc.name;
    this.service = rc.service;
    this.type = rc.type;
    this.path = `/bookmarks/services/${this.service.name}/jobs/reports/${this.name}`;
    this.oada = this.service.getClient();

    this.reportConfig = rc.reportConfig;
    this.email = rc.email;
    this.frequency = rc.frequency;
    this.sendEmpty = rc.sendEmpty ?? false;
    this.filter = rc.filter;
    this.mailer = new CronJob(
      this.frequency,
      this.sendEmail,
      null,
      true,
      'America/New_York',
      this
    );
    const interval: number =
      (this.mailer.nextDates(2) as any)[1].ts -
      (this.mailer.nextDates(1) as any)[0].ts;
    this.lastCron = moment(
      (this.mailer.nextDates(1) as any)[0] - interval
    ).format();
    info(
      `Report ${this.name} created. Next run at ${
        (this.mailer.nextDates(1) as any)[0]
      }`
    );
  }

  public async sendEmail(
    ecs?: EmailConfig,
    lastDate?: string,
    startDate?: string
  ) {
    const emailJob = {
      service: EMAIL_SVC,
      type: 'email',
      config: ecs ?? this.email(),
    };

    console.log('making report');
    const attach = await this.#getAttachment(lastDate, startDate);
    if (!attach && !this.sendEmpty) {
    console.log('report empty');
      info(
        `[Report ${this.name}] sendEmail had no records to attach. Configuration to send empty emails: [${this.sendEmpty}]`
      );
      return;
    }
    console.log('report made');

    jp.set(emailJob, `/config/attachments/0/content`, attach);

    // Queue the job to send the email
    const {
      headers: { 'content-location': location },
    } = await this.oada.post({
      path: `/resources`,
      data: emailJob as JsonObject,
    });

    if (!location) return;
    const id = location.replace(/^\/resources\//, '');
    await this.oada.put({
      path: `/bookmarks/services/${EMAIL_SVC}/jobs/pending`,
      data: {
        [id]: { _id: `resources/${id}` },
      },
      tree,
    });
    info(`[Report ${this.name}] sent email job to ${EMAIL_SVC}.`);
  }

  public async stop() {
    this.mailer.stop();
    if (this.listWatchFailures) await this.listWatchFailures.stop();
    if (this.listWatchSuccesses) await this.listWatchSuccesses.stop();
    info(`Report ${this.name} stopped.`);
  }

  public start() {
    this.mailer.start();
    const serviceTree = clone(tree);
    const star: Tree = jp.get(tree, '/bookmarks/services/*') as Tree;
    jp.set(serviceTree, `/bookmarks/services/${this.service.name}`, star);

    this.listWatchFailures = new ListWatch({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/failure`,
      name: `${this.name}-failwatch`,
      itemsPath: `$.*.day-index.*.*`,
      onNewList: AssumeState.Handled,
      tree: serviceTree,
      resume: true,
    });
    this.listWatchFailures.on(
      ChangeType.ItemAdded,
      async ({ item, pointer }) => {
        const it = await item;
        console.log('Reporting on item for report', this.name);
        await this.reportItem(this, it as Job, pointer);
      }
    );

    this.listWatchSuccesses = new ListWatch({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/success`,
      name: `${this.name}-successwatch`,
      itemsPath: `$.day-index.*.*`,
      onNewList: AssumeState.Handled,
      tree: serviceTree,
      resume: true,
    });
    this.listWatchSuccesses.on(
      ChangeType.ItemAdded,
      async ({ item, pointer }) => {
        const it = await item;
        console.log('Reporting on item for report', this.name);
        await this.reportItem(this, it as Job, pointer);
      }
    );

    info(
      `Report ${this.name} started with a frequency of [${this.frequency}].`
    );
  }

  /**
   * Generate a report entry for a finished job
   * @params
   * @params
   * @params
   */
  public async reportItem(
    report: Report,
    job: Job,
    path: string
  ): globalThis.Promise<void> {
    if (!job) return;

    if (report.type && job.type && !report.type.includes(job.type)) {
      trace(
        `[Report ${report.name}] Job was not of type ${report.type}. Skipping.`
      );
      return;
    }

    // By default filter removes nothing. filter should behave as a normal array filter (keep the truthy items)
    if (this.filter !== undefined && !this.filter(job)) {
      trace(`[Report ${report.name}] Filtered job ${job._id}. Skipping.`);
      return;
    }

    info(`Reporting ${report.name} on item.`);
    const data: any = {};
    const pieces = jp.parse(path);
    let errorType: string | undefined;
    let date: string;
    let jobid: string;
    if (pieces.length === 4) {
      errorType = pieces[0]!;
      date = pieces[2]!;
      jobid = pieces[3]!;
    } else {
      date = pieces[1]!;
      jobid = pieces[2]!;
    }

    for (const [colName, pointer] of Object.entries(
      report.reportConfig.jobMappings
    )) {
      if (pointer === 'errorMappings') {
        data[colName] = errorType
          ? report.reportConfig.errorMappings[errorType] ?? 'Other Error'
          : 'Success';
      }
    }

    for (const [colName, pointer] of Object.entries(
      report.reportConfig.jobMappings
    ).filter(([_, pointer]) => pointer !== 'errorMappings')) {
      data[colName] = jp.has(job, pointer) ? jp.get(job, pointer) : '';
    }

    await report.oada.put({
      path: `${report.path}/day-index/${date}`,
      data: {
        [jobid]: data,
      },
      tree,
    });
  }

  async #getAttachment(lastDate?: string, startDate?: string) {
    const records = await this.#gatherReportRecords(lastDate, startDate);
    const sheet = xlsx.utils.sheet_to_csv(xlsx.utils.json_to_sheet(records));
    return Buffer.from(sheet, 'utf8').toString('base64');
  }

  /**
   * Function to gather the row entries to construct the csv
   */
  async #gatherReportRecords(lastDate?: string, lastCron?: string) {
    const endTime = moment(lastDate ?? this.mailer.lastDate());
    // Iterate over the day-index
    const startTime = moment(lastCron ?? this.lastCron);
    const currentDate = moment(startTime.format('YYYY-MM-DD'));
    const records = [];
    const endDate = moment(endTime.format('YYYY-MM-DD'));
    const midnight = moment(endTime.format('YYYY-MM-DD')).add(1, 'day'); // Midnight the next day is the end of the window for previous date
    while (currentDate <= endDate) {
      const date = currentDate.format('YYYY-MM-DD');

      let day: ReportRecords;
      try {
        // @ts-expect-error
        // eslint-disable-next-line no-await-in-loop
        ({ data: day } = await this.oada.get({
          path: `${this.path}/day-index/${date}`,
        }));
      } catch (error: any) {
        if (error.status !== 404) {
          throw error as Error;
        }

        day = {};
      }

      // Remove oada keys, filter by time (key)
      const items = Object.keys(day)
        .filter((key) => !key.startsWith('_'))
        .filter((key) => moment(ksuid.parse(key).date) < midnight)
        // Server offset
        //          let d = moment(ksuid.parse(key).date).subtract(4, 'minutes').subtract(15, 'seconds');
        //          return d < midnight
        //        })
        .map((key) => day[key]);

      records.push(...items);

      currentDate.add(1, 'day');
    }

    this.lastCron = this.mailer.lastDate().toString();
    return records;
  }
}

export async function reportOnItem(
  report: Report,
  job: Job,
  path: string
): globalThis.Promise<void> {
  if (!job) return;

  if (report.type && job.type && !report.type.includes(job.type)) {
    trace(
      `[Report ${report.name}] Job was not of type ${report.type}. Skipping.`
    );
    return;
  }

  info(`Reporting ${report.name} on item.`);
  const data: any = {};
  const pieces = jp.parse(path);
  let errorType: string | undefined;
  let date: string;
  let jobId: string;
  if (pieces.length === 4) {
    errorType = pieces[0]!;
    date = pieces[2]!;
    jobId = pieces[3]!;
  } else {
    date = pieces[1]!;
    jobId = pieces[2]!;
  }

  for (const [colName, pointer] of Object.entries(
    report.reportConfig.jobMappings
  )) {
    if (pointer === 'errorMappings') {
      data[colName] = errorType
        ? report.reportConfig.errorMappings[errorType] ?? 'Other Error'
        : 'Success';
    }
  }

  for (const [colName, pointer] of Object.entries(
    report.reportConfig.jobMappings
  ).filter(([_, pointer]) => pointer !== 'errorMappings')) {
    data[colName] = jp.get(job, pointer) ?? '';
  }

  await report.oada.put({
    path: `${report.path}/day-index/${date}`,
    data: {
      [jobId]: data,
    },
    tree,
  });
}

// This generally assumes the thing passed to it is the abalonemail job
// config.attachments[*].content buffer string created above by the
// gatherAttachment method
export function parseAttachment(buffString: string) {
  const wb = xlsx.read(buffString, {
    type: 'base64',
  }) as unknown as { Sheets: { Sheet1: any } };
  return xlsx.utils.sheet_to_json(wb.Sheets.Sheet1);
}

export type EmailConfigSetup = () => EmailConfig;

export interface ReportConfig {
  jobMappings: Record<string, string>;
  errorMappings: Record<string, string>;
}

type ReportRecords = Record<string, ReportRecord>;

type ReportRecord = Record<string, string>;
