//import type { Job } from '@oada/jobs';
import clone from 'clone-deep';
import type EmailConfig from '@oada/types/trellis/service/abalonemail/config/email.js';
import { ListWatch } from '@oada/list-lib';
import type Job from '@oada/types/oada/service/job.js';
//@ts-ignore
import jp from 'json-pointer';
import ksuid from 'ksuid';
import type { JsonObject, OADAClient } from '@oada/client';
import { CronJob } from 'cron';
import moment from 'moment';
//@ts-ignore
import csvjson from 'csvjson';
import debug from 'debug';
import Promise from 'bluebird';
import type { Service } from './Service.js';
import { tree } from './tree.js';

//const error = debug('oada-jobs:connection:error');
const info = debug('oada-jobs:connection:info');
//const warn = debug('oada-jobs:connection:warn');
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
  type: string | Array<string> | undefined;
  listWatchFailures: ListWatch | undefined;
  listWatchSuccesses: ListWatch | undefined;

  /**
   * @param name The name of the report
   * @param domain_or_oada The domain of the queue to watch, or an existing oada client.
   * @param reportConfig The configuration used to derive CSV rows from the jobs list.
   * @param service The `Service` which the watch is operating under
   * @param frequency A cron-like string describing the frequency of the emailer.
   * @param email A callback used to generate the email job
   * @param type The subservice type to report on
   * @param token Token to use to connect to OADA if necessary
   */
  constructor(
    name: string,
    domain_or_oada: string | OADAClient,
    reportConfig: ReportConfig,
    service: Service,
    frequency: string,
    email: EmailConfigSetup,
    type?: string,
    token?: string,
  ) {
    this.name = name;
    this.service = service;
    this.type = type;
    this.path = `/bookmarks/services/${this.service.name}/jobs/reports/${this.name}`;
    if (typeof domain_or_oada === 'string') {
      this.oada = this.service.getClient(domain_or_oada).clone(token || '');
    } else {
      debug(`[Report ${this.name}]: Using OADAClient from constructor`);
      this.oada = domain_or_oada;
    }
    this.reportConfig = reportConfig;
    this.email = email;
    this.frequency = frequency;
    this.mailer = new CronJob(
      this.frequency,
      this.sendEmail,
      null,
      true,
      'America/New_York',
      this
    )
    let interval : number = (this.mailer.nextDates(2) as any)[1].ts - (this.mailer.nextDates(1) as any)[0].ts;
    //@ts-ignore
    this.lastCron = moment((this.mailer.nextDates(1) as any)[0] - interval).format();
    info(`Report ${this.name} created. Next run at ${(this.mailer.nextDates(1)as any)[0]}`);
  }

  private async getAttachment() {
    let records = await this.gatherReportRecords()
    let csvdat = csvjson.toCSV(records, {delimiter: ",", wrap: false, headers: "relative"})
    //return btoa(csvdat);
    return Buffer.from(csvdat, 'utf8').toString('base64');
    //let csvdat = csvjson.toCSV(records, {delimiter: ",", wrap: false})
    //return Buffer.from(csvdat, 'base64').toString();
  }

  public async sendEmail() {

    let emailJob = {
      "service": "abalonemail",
      "type": "email",
      "config": this.email(),
    };

    if (emailJob.config.attachments!.length > 0) {
      emailJob.config.attachments![0]!.content = await this.getAttachment();
    } else {
      info(`[Report ${this.name}] sendEmail had no attachments.`);
      return;
    }

    //TODO Assert the EmailConfig??

    // Queue the job to send the email
    await this.oada.post({
      path: `/bookmarks/services/abalonemail/jobs/pending`,
      data: emailJob as JsonObject,
      tree
    })
    info(`[Report ${this.name}] sent email job to abalonemail.`);
  }

  /*
   * Function to gather the row entries to construct the csv
   */
  private async gatherReportRecords() {
    let endTime = moment(this.mailer.lastDate());
    //Iterate over the day-index
    let startTime = moment(this.lastCron);
    let curDate = moment(startTime.format('YYYY-MM-DD'));
    let records = [];
    let endDate = moment(endTime.format('YYYY-MM-DD'))
    while (curDate <= endDate) {
      let date = curDate.format('YYYY-MM-DD');

      let day = await this.oada.get({
        path: `${this.path}/day-index/${date}`
      }).then(r => r.data as ReportRecords)
      .catch(err => {
        if (err.status !== 404) throw err;
        return {} as ReportRecords;
      })

      // Remove oada keys, filter by time (key)
      let items = Object.keys(day)
        .filter(key => key.charAt(0) !== '_')
        .filter(key => {
          let d = moment(ksuid.parse(key).date).subtract(4, 'minutes').subtract(15, 'seconds');
          return moment(d) > startTime && moment(d) < endTime
        })
        .map(key => day[key])

      records.push(...items);

      curDate.add(1, 'day');
    }

    this.lastCron = this.mailer.lastDate().toString();
    return records;
  }

  public stop() {
    this.mailer.stop();
    if (this.listWatchFailures) this.listWatchFailures.stop();
    if (this.listWatchSuccesses) this.listWatchSuccesses.stop();
    info(`Report ${this.name} stopped.`);
  }

  public start() {
    this.mailer.start();
    let serviceTree = clone(tree);
    let star = jp.get(tree, '/bookmarks/services/*');
    jp.set(serviceTree, `/bookmarks/services/${this.service.name}`, star)
    this.listWatchFailures = new ListWatch<Job>({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/failure`,
      name: `${this.name}-failwatch`,
      itemsPath: `$.*.day-index.*.*`,
      onAddItem: (job, id) => {
        this.reportItem(this, job, id)
      },
      onNewList: ListWatch.AssumeHandled,
      tree: serviceTree,
      resume: true
    })

    this.listWatchSuccesses = new ListWatch<Job>({
      conn: this.oada,
      path: `/bookmarks/services/${this.service.name}/jobs/success`,
      name: `${this.name}-successwatch`,
      itemsPath: `$.day-index.*.*`,
      onAddItem: (job, id) => {
        this.reportItem(this, job, id)
      },
      onNewList: ListWatch.AssumeHandled,
      tree: serviceTree,
      resume: true
    })

    info(`Report ${this.name} started with a frequency of [${this.frequency}].`);
  }

  /**
   * Generate a report entry for a finished job
   * @params
   * @params
   * @params
   */
  private async reportItem(
    report: Report,
    job: Job,
    path: string,
  ): globalThis.Promise<void> {

      if (!job) return;

      //TODO: on first test, job.type was undefined. It should have a type to
      //check here
      if (report.type && job.type && !report.type.includes(job.type)) {
        trace(`[Report ${report.name}] Job was not of type ${report.type}. Skipping.`);
        return;
      }
      let data: any = {};
      //Trellis Result;
      //Additional Reasons;
      //FoodLogiQ Link;
      let pieces = jp.parse(path);
      let errorType: string | undefined, date: string, jobid: string;
      if (pieces.length === 4) {
        errorType = pieces[0];
        date = pieces[2];
        jobid = pieces[3];
      } else {
        date = pieces[1];
        jobid = pieces[2]
      }

      try {
        Object.entries(report.reportConfig.jobMappings).forEach(([colName, pointer]) => {
          if (pointer === "errorMappings") {
            if (errorType) {
              data[colName] = report.reportConfig.errorMappings[errorType] || 'Other Error';
            } else {
              data[colName] = 'Success'
            }
          }
        })

        Object.entries(report.reportConfig.jobMappings)
          .filter(([_, pointer]) => pointer !== "errorMappings")
          .forEach(([colName, pointer]) => {
            data[colName] = jp.get(job, pointer) || '';
          })

        await report.oada.put({
          path: `${report.path}/day-index/${date}`,
          data: {
            [jobid]: data,
          },
          tree,
        })
      } catch(err) {
        return;
      }
  }
}

export interface EmailConfigSetup{
  (): EmailConfig
}

export interface ReportConfig {
  jobMappings: {
    [key: string]: string;
  };
  errorMappings: {
    [key: string]: string;
  };
}

interface ReportRecords{
  [key: string]: ReportRecord;
}

interface ReportRecord{
  [key: string]: string;
}