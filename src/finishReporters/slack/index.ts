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

import tiny from "tiny-json-http"; // For finishReporters

import type { FinishReporter, Job, Service } from "../.././index.js";
import { error, info } from "../../utils.js";

interface FinishParameters {
  config: FinishReporter;
  service: Service;
  finalpath: string;
  job: Job;
  jobId: string;
  status: string;
}

export async function onFinish(p: FinishParameters): Promise<void> {
  let { domain } = p.service;
  if (!domain.startsWith("http")) {
    domain = `https://${domain}`;
  }

  const message = {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Service *${p.job.service}* on Domain *${domain}* failed jobId *${p.jobId}*`,
        },
      },
      {
        type: "divider",
      },
      {
        type: "section",
        block_id: "section567",
        text: {
          type: "mrkdwn",
          text: `<${domain}${p.finalpath}>`,
        },
      },
    ],
    attachments: [
      {
        blocks: [
          // Doing the code in an "attachement" makes it "secondary" and therefore collapsed by default
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `\`\`\`${JSON.stringify(p.job, undefined, "  ")}\`\`\``,
            },
          },
        ],
      },
    ],
  } as const;

  if (!p.config.posturl) {
    error(
      "finishReporters#slack: Slack requires a posturl and you did not pass one",
    );
    return;
  }

  try {
    await tiny.post({
      url: p.config.posturl,
      data: message,
      headers: { "content-type": "application/json" },
    });
    info(
      "Successfully posted message to slack about job with status %s",
      p.status,
    );
  } catch (err: unknown) {
    error(
      err,
      "finishReporters#slack: ERROR: failed to post message to slack!",
    );
  }
}