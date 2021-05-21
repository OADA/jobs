import tiny from 'tiny-json-http'; // for finishReporters
import { error, info } from '../../utils';

import type { FinishReporter, Service, Job } from '../../.';

interface FinishParams {
  config: FinishReporter;
  service: Service;
  finalpath: string;
  job: Job;
  jobId: string;
  status: string;
}

export async function onFinish(p: FinishParams): Promise<void> {
  let domain = p.service.domain;
  if (!domain.match(/^http/)) domain = 'https://' + domain;

  const message = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `Service *${p.job.service}* on Domain *${domain}* failed jobid *${p.jobId}*`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        block_id: 'section567',
        text: {
          type: 'mrkdwn',
          text: `<${domain}${p.finalpath}>`,
        },
      },
    ],
    attachments: [
      {
        blocks: [
          // doing the code in an "attachement" makes it "secondary" and therefore collapsed by default
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`${JSON.stringify(p.job, null, '  ')}\`\`\``,
            },
          },
        ],
      },
    ],
  };

  if (!p.config.posturl) {
    error(
      'finishReporters#slack: Slack requires a posturl and you did not pass one'
    );
    return;
  }

  await tiny
    .post({
      url: p.config.posturl,
      data: message,
      headers: { 'content-type': 'application/json' },
    })
    .then(() =>
      info(
        'Successfully posted message to slack about job with status ',
        p.status
      )
    )
    .catch((e: any) => {
      error(
        'finishReporters#slack: ERROR: failed to post message to slack!  Error was: ',
        e
      );
    });
}
