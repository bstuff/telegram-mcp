import crypto from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import bigInt from "big-integer";
import type { TelegramClient } from "telegram";
import { Api, entityName, getClient, resolveChat } from "../client.ts";
import { messageLink, pollAnswerText, pollQuestion } from "../format.ts";
import type { Entity } from "../types.ts";
import { bar, chatArg, pct, tool, z } from "./helpers.ts";

/** Random 56-bit id — poll ids only need to be unique per chat. */
const randomPollId = () => bigInt(crypto.randomBytes(7).toString("hex"), 16);

const asTextWithEntities = (text: string) => new Api.TextWithEntities({ text, entities: [] });

interface FetchedPoll {
  client: TelegramClient;
  entity: Entity;
  title: string;
  media: Api.MessageMediaPoll;
}

async function fetchPoll(chat: string, messageId: number): Promise<FetchedPoll> {
  const client = await getClient();
  const { entity, title } = await resolveChat(chat);
  const [message] = await client.getMessages(entity, { ids: [messageId] });
  if (!message) throw new Error(`Message #${messageId} not found in "${title}".`);
  if (message.media?.className !== "MessageMediaPoll") {
    throw new Error(`Message #${messageId} in "${title}" is not a poll.`);
  }
  return { client, entity, title, media: message.media };
}

function renderResults(
  poll: Api.Poll,
  results: Api.PollResults | undefined,
  voters?: Map<number, string[]>
): string {
  const answers = poll.answers;
  const byOption = new Map<string, Api.PollAnswerVoters>();
  for (const r of results?.results ?? []) byOption.set(r.option.toString("hex"), r);
  const total = results?.totalVoters ?? 0;
  const maxVotes = Math.max(1, ...(results?.results ?? []).map((r) => r.voters));

  const lines = answers.map((answer, i) => {
    const r = byOption.get(answer.option.toString("hex"));
    const count = r?.voters ?? 0;
    const marks = [r?.chosen ? "← your vote" : "", r?.correct ? "✓ correct" : ""].filter(Boolean).join(" ");
    const names = voters?.get(i);
    const votedBy = names?.length ? `\n       voted: ${names.join(", ")}` : "";
    return `  ${i}. ${pollAnswerText(answer).padEnd(24)} ${bar(count, maxVotes, 14).padEnd(14)} ${String(
      count
    ).padStart(4)} (${pct(count, total)}) ${marks}${votedBy}`;
  });

  const flags = [
    poll.multipleChoice ? "multiple choice" : "single choice",
    poll.quiz ? "quiz" : null,
    poll.publicVoters ? "public votes" : "anonymous",
    poll.closed ? "CLOSED" : "open",
  ].filter(Boolean);

  const out = [`"${pollQuestion(poll)}" [${flags.join(", ")}]`, `Total voters: ${total}`, ...lines];
  if (results?.solution) out.push(`Explanation: ${results.solution}`);
  return out.join("\n");
}

export function registerPollTools(server: McpServer): void {
  tool(
    server,
    "create_poll",
    {
      title: "Start a poll",
      description:
        "Post a poll in a chat. Supports multiple choice, public (non-anonymous) votes, quiz mode with a correct answer, and auto-closing after N seconds. Telegram does not allow polls in private chats.",
      inputSchema: {
        chat: chatArg,
        question: z.string().min(1).max(255),
        options: z.array(z.string().min(1).max(100)).min(2).max(10).describe("Answer options, 2 to 10."),
        multiple: z.boolean().default(false).describe("Allow selecting several options."),
        anonymous: z.boolean().default(true).describe("false = everyone can see who voted for what."),
        quiz_correct_option: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Turns the poll into a quiz; 0-based index of the correct option."),
        explanation: z.string().max(200).optional().describe("Shown after answering a quiz."),
        close_in_seconds: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe("Auto-close the poll after this many seconds (5-600)."),
        reply_to: z.number().int().optional(),
        silent: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({
      chat,
      question,
      options,
      multiple,
      anonymous,
      quiz_correct_option,
      explanation,
      close_in_seconds,
      reply_to,
      silent,
    }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const isQuiz = quiz_correct_option !== undefined;
      if (isQuiz && quiz_correct_option >= options.length) {
        throw new Error(
          `quiz_correct_option ${quiz_correct_option} is out of range (${options.length} options).`
        );
      }
      if (isQuiz && multiple) throw new Error("A quiz cannot allow multiple answers.");

      const poll = new Api.Poll({
        id: randomPollId(),
        question: asTextWithEntities(question),
        answers: options.map(
          (opt, i) => new Api.PollAnswer({ text: asTextWithEntities(opt), option: Buffer.from([i]) })
        ),
        multipleChoice: multiple,
        publicVoters: !anonymous,
        quiz: isQuiz,
        closePeriod: close_in_seconds,
      });

      const media = new Api.InputMediaPoll({
        poll,
        correctAnswers: isQuiz ? [Buffer.from([quiz_correct_option])] : undefined,
        solution: explanation,
        solutionEntities: explanation ? [] : undefined,
      });

      const message = await client.sendFile(entity, { file: media, replyTo: reply_to, silent });
      const link = messageLink(entity, message.id);
      return [
        `Poll #${message.id} posted in "${title}"${link ? ` — ${link}` : ""}`,
        `"${question}"`,
        ...options.map((o, i) => `  ${i}. ${o}${isQuiz && i === quiz_correct_option ? "  (correct)" : ""}`),
        close_in_seconds ? `Closes in ${close_in_seconds}s.` : "",
        `Read results later with poll_results(chat, ${message.id}).`,
      ]
        .filter(Boolean)
        .join("\n");
    }
  );

  tool(
    server,
    "poll_results",
    {
      title: "Poll results",
      description: "Current results of a poll: votes per option, percentages, and (for public polls) who voted.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int().describe("Id of the message containing the poll."),
        with_voters: z
          .boolean()
          .default(false)
          .describe("List voter names — only possible for non-anonymous polls."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, with_voters }) => {
      const { client, entity, title, media } = await fetchPoll(chat, message_id);

      let poll = media.poll;
      let results = media.results;
      try {
        const fresh = await client.invoke(
          new Api.messages.GetPollResults({ peer: entity, msgId: message_id })
        );
        if ("updates" in fresh) {
          for (const u of fresh.updates) {
            if (u.className === "UpdateMessagePoll") {
              poll = u.poll ?? poll;
              results = u.results;
            }
          }
        }
      } catch {
        /* fall back to the cached results attached to the message */
      }

      let voters: Map<number, string[]> | undefined;
      if (with_voters && poll.publicVoters) {
        voters = new Map();
        for (const [i, answer] of poll.answers.entries()) {
          try {
            const res = await client.invoke(
              new Api.messages.GetPollVotes({
                peer: entity,
                id: message_id,
                option: answer.option,
                limit: 50,
              })
            );
            const names = new Map(res.users.map((u) => [u.id.toString(), entityName(u as Entity)]));
            voters.set(
              i,
              res.votes.map((v) => {
                const id = "peer" in v && v.peer.className === "PeerUser" ? v.peer.userId.toString() : "";
                return names.get(id) ?? "someone";
              })
            );
          } catch {
            voters.set(i, []);
          }
        }
      }

      const note =
        with_voters && !poll.publicVoters
          ? "\n(votes are anonymous — voter names are not available)"
          : "";
      return `Poll #${message_id} in "${title}"\n${renderResults(poll, results, voters)}${note}`;
    }
  );

  tool(
    server,
    "vote_poll",
    {
      title: "Vote in a poll",
      description: "Cast your own vote in an existing poll.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int(),
        options: z
          .array(z.union([z.number().int(), z.string()]))
          .min(1)
          .describe("Option indexes (0-based) or exact option texts. Several only if the poll allows it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, message_id, options }) => {
      const { client, entity, title, media } = await fetchPoll(chat, message_id);
      const answers = media.poll.answers;
      if (media.poll.closed) throw new Error(`Poll #${message_id} is already closed.`);
      if (options.length > 1 && !media.poll.multipleChoice) {
        throw new Error("This poll only accepts a single answer.");
      }

      const chosen = options.map((opt) => {
        if (typeof opt === "number") {
          const answer = answers[opt];
          if (!answer) throw new Error(`Option index ${opt} is out of range (${answers.length} options).`);
          return answer;
        }
        const hit = answers.find((a) => pollAnswerText(a).toLowerCase() === opt.toLowerCase());
        if (!hit) {
          const available = answers.map((a, i) => `${i}=${pollAnswerText(a)}`).join(", ");
          throw new Error(`No option "${opt}". Available: ${available}`);
        }
        return hit;
      });

      await client.invoke(
        new Api.messages.SendVote({
          peer: entity,
          msgId: message_id,
          options: chosen.map((a) => a.option),
        })
      );
      const names = chosen.map((a) => `"${pollAnswerText(a)}"`).join(", ");
      return `Voted for ${names} in poll #${message_id} ("${title}").`;
    }
  );

  tool(
    server,
    "close_poll",
    {
      title: "Close a poll",
      description: "Stop a poll you created so no further votes are accepted, and return the final results.",
      inputSchema: { chat: chatArg, message_id: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      const { client, entity, title, media } = await fetchPoll(chat, message_id);
      if (media.poll.closed) {
        return `Poll #${message_id} in "${title}" is already closed.\n${renderResults(media.poll, media.results)}`;
      }

      const closed = new Api.Poll({
        id: media.poll.id,
        question: media.poll.question,
        answers: media.poll.answers,
        multipleChoice: media.poll.multipleChoice,
        publicVoters: media.poll.publicVoters,
        quiz: media.poll.quiz,
        closed: true,
      });
      await client.invoke(
        new Api.messages.EditMessage({
          peer: entity,
          id: message_id,
          media: new Api.InputMediaPoll({ poll: closed }),
        })
      );

      const [updated] = await client.getMessages(entity, { ids: [message_id] });
      const fresh = updated?.media?.className === "MessageMediaPoll" ? updated.media : media;
      return `Closed poll #${message_id} in "${title}".\n${renderResults(fresh.poll, fresh.results)}`;
    }
  );
}
