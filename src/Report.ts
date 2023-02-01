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
// @ts-expect-error -- no types for csvjson
import csvjson from 'csvjson';
import debug from 'debug';
import jp from 'json-pointer';
import ksuid from 'ksuid';
import moment from 'moment';

// Import type { Job } from '@oada/jobs';
import type { JsonObject, OADAClient } from '@oada/client';
import type EmailConfig from '@oada/types/trellis/service/abalonemail/config/email.js';
import type Job from '@oada/types/oada/service/job.js';
import { ListWatch } from '@oada/list-lib';
import type Tree from '@oada/types/oada/tree/v1.js';

import type { Service } from './Service.js';
import { tree } from './tree.js';
// Const error = debug('oada-jobs:connection:error');
const info = debug('oada-jobs:connection:info');
// Const warn = debug('oada-jobs:connection:warn');
const trace = debug('oada-jobs:connection:trace');

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
  noEmptyReports: boolean;
  type: string | string[] | undefined;
  listWatchFailures: ListWatch | undefined;
  listWatchSuccesses: ListWatch | undefined;

  /**
   * @param name The name of the report
   * @param domainOrOada The domain of the queue to watch, or an existing oada client.
   * @param reportConfig The configuration used to derive CSV rows from the jobs list.
   * @param service The `Service` which the watch is operating under
   * @param frequency A cron-like string describing the frequency of the emailer.
   * @param email A callback used to generate the email job
   * @param type The subservice type to report on
   * @param token Token to use to connect to OADA if necessary
   * @param noEmptyReports configure whether empty reports should be sent (default=true)
   */
  constructor(
    name: string,
    domainOrOada: string | OADAClient,
    reportConfig: ReportConfig,
    service: Service,
    frequency: string,
    email: EmailConfigSetup,
    type?: string,
    token?: string,
    noEmptyReports?: boolean
  ) {
    this.name = name;
    this.service = service;
    this.type = type;
    this.path = `/bookmarks/services/${this.service.name}/jobs/reports/${this.name}`;
    if (typeof domainOrOada === 'string') {
      this.oada = this.service.getClient(domainOrOada).clone(token ?? '');
    } else {
      debug(`[Report ${this.name}]: Using OADAClient from constructor`);
      this.oada = domainOrOada;
    }

    this.reportConfig = reportConfig;
    this.email = email;
    this.frequency = frequency;
    this.noEmptyReports = noEmptyReports ?? true;
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
      service: 'abalonemail',
      type: 'email',
      config: ecs ?? this.email(),
    };

    if (emailJob.config.attachments && emailJob.config.attachments.length > 0) {
      const attach = await this.#getAttachment(lastDate, startDate);
      if (attach) {
        emailJob.config.attachments[0]!.content = attach;
      } else {
        info(`[Report ${this.name}] sendEmail had no records to attach.`);
      }
    } else {
      info(`[Report ${this.name}] sendEmail had no attachments.`);
      return;
    }

    // TODO Assert the EmailConfig??

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
      path: `/bookmarks/services/abalonemail/jobs/pending`,
      data: {
        [id]: { _id: `resources/${id}` },
      },
      tree,
    });
    info(`[Report ${this.name}] sent email job to abalonemail.`);
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
    this.listWatchFailures = new ListWatch<Job>({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/failure`,
      name: `${this.name}-failwatch`,
      itemsPath: `$.*.day-index.*.*`,
      onAddItem: (job: any, id: any) => {
        this.reportItem(this, job, id);
      },
      onNewList: ListWatch.AssumeHandled,
      tree: serviceTree,
      resume: true,
    });

    this.listWatchSuccesses = new ListWatch<Job>({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/success`,
      name: `${this.name}-successwatch`,
      itemsPath: `$.day-index.*.*`,
      onAddItem: (job: any, id: any) => {
        this.reportItem(this, job, id);
      },
      onNewList: ListWatch.AssumeHandled,
      tree: serviceTree,
      resume: true,
    });

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

    // TODO: on first test, job.type was undefined. It should have a type to
    // check here
    if (report.type && job.type && !report.type.includes(job.type)) {
      trace(
        `[Report ${report.name}] Job was not of type ${report.type}. Skipping.`
      );
      return;
    }

    info(`Reporting ${report.name} on item.`);
    const data: any = {};
    // Trellis Result;
    // Additional Reasons;
    // FoodLogiQ Link;
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
    if (records.length === 0 && this.noEmptyReports) return;
    const csvData = csvjson.toCSV(records, {
      delimiter: ',',
      wrap: false,
      headers: 'relative',
    });
    return Buffer.from(csvData, 'utf8').toString('base64');
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

  // TODO: on first test, job.type was undefined. It should have a type to
  // check here
  if (report.type && job.type && !report.type.includes(job.type)) {
    trace(
      `[Report ${report.name}] Job was not of type ${report.type}. Skipping.`
    );
    return;
  }

  info(`Reporting ${report.name} on item.`);
  const data: any = {};
  // Trellis Result;
  // Additional Reasons;
  // FoodLogiQ Link;
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

export type EmailConfigSetup = () => EmailConfig;

export interface ReportConfig {
  jobMappings: Record<string, string>;
  errorMappings: Record<string, string>;
}

type ReportRecords = Record<string, ReportRecord>;

type ReportRecord = Record<string, string>;
