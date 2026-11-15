import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.OPEN_WEB_TEST_URL;
const databasePath = process.env.OPEN_WEB_TEST_DB;
if (!base || !databasePath) throw Error('Expansion browser review needs an isolated site and database');
const screenshots = process.env.EXPANSION_SCREENSHOT_DIR;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const desktopContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const otherWriterContext = await browser.newContext({ viewport: { width: 1240, height: 900 } });
const boundaryContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = [];

async function open(context, path) {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${path}: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('WebSocket') && !message.text().includes('status of 409 (Conflict)')) {
      errors.push(`${path}: ${message.text()}`);
    }
  });
  await page.goto(`${base}${path}`);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  return page;
}

async function shot(page, name) {
  if (!screenshots) return;
  mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: join(screenshots, name), fullPage: true });
}

async function seed(work) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    work(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

try {
  // Guestbook: a ruled visitor ledger, with the writing surface beside it.
  const guestbook = await open(desktopContext, '/guestbook');
  await guestbook.getByRole('heading', { name: 'Guestbook' }).waitFor();
  await guestbook.getByText('No signatures yet. Leave the first one.', { exact: true }).waitFor();
  await shot(guestbook, 'guestbook-desktop-empty.png');
  await guestbook.locator('#guestbook-name').fill('A passing reader');
  await guestbook.locator('#guestbook-message').fill('A small note left for whoever comes by next.');
  await shot(guestbook, 'guestbook-desktop-interaction.png');
  const guestResponse = guestbook.waitForResponse(response => response.url().endsWith('/api/guestbook/entries') && response.request().method() === 'POST');
  await guestbook.getByRole('button', { name: 'Leave a signature' }).click();
  assert.equal((await guestResponse).status(), 200);
  await guestbook.getByText('A small note left for whoever comes by next.', { exact: true }).waitFor();
  await shot(guestbook, 'guestbook-desktop-populated.png');
  await seed(db => {
    const insert = db.prepare('INSERT INTO guestbook_entries(created_at, display_name, body) VALUES (?, ?, ?)');
    for (let i = 0; i < 23; i++) insert.run(Date.now() - i * 1000, `Visitor ${String(i + 1).padStart(2, '0')}`, `A quiet mark in the book, number ${i + 1}.`);
  });
  await guestbook.reload();
  await guestbook.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  assert.equal(await guestbook.locator('#guestbook-list li').count(), 20);
  const olderGuestPage = guestbook.waitForResponse(response => response.url().includes('/api/guestbook/entries?before='));
  await guestbook.getByRole('button', { name: 'Older entries' }).click();
  assert.equal((await olderGuestPage).status(), 200);
  assert.equal(await guestbook.locator('#guestbook-list li').count(), 4);
  await guestbook.getByRole('button', { name: 'Back to latest' }).waitFor();
  await shot(guestbook, 'guestbook-desktop-older-page.png');

  const guestbookMobile = await open(mobileContext, '/guestbook');
  await guestbookMobile.getByRole('heading', { name: 'Guestbook' }).waitFor();
  await guestbookMobile.locator('#guestbook-list li').first().waitFor();
  await shot(guestbookMobile, 'guestbook-mobile-populated.png');
  await guestbookMobile.locator('#guestbook-name').fill('On a phone');
  await guestbookMobile.locator('#guestbook-message').fill('The first page fits in my hands.');
  await shot(guestbookMobile, 'guestbook-mobile-interaction.png');
  const mobileGuestResponse = guestbookMobile.waitForResponse(response => response.url().endsWith('/api/guestbook/entries') && response.request().method() === 'POST');
  await guestbookMobile.getByRole('button', { name: 'Leave a signature' }).click();
  assert.equal((await mobileGuestResponse).status(), 200);
  await guestbookMobile.getByText('The first page fits in my hands.', { exact: true }).waitFor();

  // The Story: one continuous reading column with an explicit stale-ending review.
  const story = await open(desktopContext, '/story');
  await story.getByRole('heading', { name: 'The Story' }).waitFor();
  await story.getByText('No one has started the story yet.', { exact: true }).waitFor();
  await shot(story, 'story-desktop-empty.png');
  const otherWriter = await open(otherWriterContext, '/story');
  await otherWriter.locator('#story-passage').fill('The path bent toward the old station.');
  await story.locator('#story-passage').fill('At dusk, a paper boat appeared in the road.');
  await shot(story, 'story-desktop-interaction.png');
  const firstStory = story.waitForResponse(response => response.url().endsWith('/api/story/contributions') && response.request().method() === 'POST');
  await story.getByRole('button', { name: 'Add a passage' }).click();
  assert.equal((await firstStory).status(), 200);
  await story.locator('.story-fragment').filter({ hasText: 'At dusk, a paper boat appeared in the road.' }).waitFor();
  const staleStory = otherWriter.waitForResponse(response => response.url().endsWith('/api/story/contributions') && response.request().method() === 'POST');
  await otherWriter.getByRole('button', { name: 'Add a passage' }).click();
  assert.equal((await staleStory).status(), 409);
  await otherWriter.getByRole('button', { name: 'I’ve read the new ending' }).waitFor();
  assert.equal(await otherWriter.locator('#story-passage').inputValue(), 'The path bent toward the old station.');
  await otherWriter.getByRole('button', { name: 'I’ve read the new ending' }).click();
  const secondStory = otherWriter.waitForResponse(response => response.url().endsWith('/api/story/contributions') && response.request().method() === 'POST');
  await otherWriter.getByRole('button', { name: 'Add a passage' }).click();
  assert.equal((await secondStory).status(), 200);
  await story.reload();
  await story.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await story.locator('.story-fragment').nth(1).waitFor();
  await shot(story, 'story-desktop-populated.png');

  const mobileStory = await open(mobileContext, '/story');
  await mobileStory.locator('.story-fragment').first().waitFor();
  await mobileStory.locator('#story-passage').fill('Someone had left the station light on.');
  await shot(mobileStory, 'story-mobile-interaction.png');
  const mobileStoryResponse = mobileStory.waitForResponse(response => response.url().endsWith('/api/story/contributions') && response.request().method() === 'POST');
  await mobileStory.getByRole('button', { name: 'Add a passage' }).click();
  assert.equal((await mobileStoryResponse).status(), 200);
  await mobileStory.locator('.story-fragment').filter({ hasText: 'Someone had left the station light on.' }).waitFor();
  await shot(mobileStory, 'story-mobile-populated.png');

  const storyState = await (await fetch(`${base}/api/story/state`)).json();
  const currentChapter = storyState.chapter.number;
  seed(db => {
    const chapterId = db.prepare('SELECT id FROM story_chapters WHERE chapter_no=?').get(currentChapter).id;
    const insert = db.prepare('INSERT INTO story_contributions(chapter_id, ordinal, created_at, body) VALUES (?, ?, ?, ?)');
    for (let ordinal = 4; ordinal <= 39; ordinal++) insert.run(chapterId, ordinal, Date.now(), `A short archived-in-the-making passage ${ordinal}.`);
    db.prepare('UPDATE story_chapters SET revision=39 WHERE id=?').run(chapterId);
  });
  const boundaryPage = await open(boundaryContext, '/story');
  await boundaryPage.locator('.story-fragment').nth(38).waitFor();
  await shot(boundaryPage, 'story-desktop-chapter-boundary.png');
  await boundaryPage.locator('#story-passage').fill('At forty, the little chapter folded into the next.');
  const boundaryResponse = boundaryPage.waitForResponse(response => response.url().endsWith('/api/story/contributions') && response.request().method() === 'POST');
  await boundaryPage.getByRole('button', { name: 'Add a passage' }).click();
  assert.equal((await boundaryResponse).status(), 200);
  await boundaryPage.getByRole('button', { name: 'Go to the open chapter' }).click();
  await boundaryPage.getByText('This chapter is waiting for its first passage.', { exact: true }).waitFor();
  await shot(boundaryPage, 'story-desktop-next-chapter.png');

  // Open Questions: an index on the left, one selected question and its answers on the right.
  const questions = await open(desktopContext, '/questions');
  await questions.getByRole('heading', { name: 'Open Questions' }).waitFor();
  await questions.getByText('No questions yet. Ask the first one.', { exact: true }).waitFor();
  await shot(questions, 'questions-desktop-empty.png');
  await questions.locator('#question-input').fill('What tiny thing made today better?');
  await shot(questions, 'questions-desktop-interaction.png');
  const questionResponse = questions.waitForResponse(response => response.url().endsWith('/api/questions') && response.request().method() === 'POST');
  await questions.getByRole('button', { name: 'Ask', exact: true }).click();
  const questionStatus = await questionResponse;
  assert.equal(questionStatus.status(), 200);
  const questionPayload = await questionStatus.json();
  const questionId = questionPayload.question.id;
  await questions.getByRole('heading', { name: 'What tiny thing made today better?' }).waitFor();
  await questions.locator('#answer-input').fill('<img src=x onerror=alert(1)> A warm cup of tea.');
  const firstAnswer = questions.waitForResponse(response => response.url().endsWith(`/api/questions/${questionId}/answers`) && response.request().method() === 'POST');
  await questions.getByRole('button', { name: 'Add your answer' }).click();
  assert.equal((await firstAnswer).status(), 200);
  await questions.locator('#answer-list').getByText('<img src=x onerror=alert(1)> A warm cup of tea.', { exact: true }).waitFor();
  assert.equal(await questions.locator('#answer-list img').count(), 0);
  assert.equal(await questions.locator(`.question-link[data-question-id="${questionId}"] .question-link-meta span`).nth(1).textContent(), '1 answer');
  await shot(questions, 'questions-desktop-populated.png');

  const mobileQuestions = await open(mobileContext, `/questions?id=${questionId}`);
  await mobileQuestions.getByRole('heading', { name: 'What tiny thing made today better?' }).waitFor();
  await mobileQuestions.locator('#answer-input').fill('A stranger held the door.');
  await shot(mobileQuestions, 'questions-mobile-interaction.png');
  const mobileAnswer = mobileQuestions.waitForResponse(response => response.url().endsWith(`/api/questions/${questionId}/answers`) && response.request().method() === 'POST');
  await mobileQuestions.getByRole('button', { name: 'Add your answer' }).click();
  assert.equal((await mobileAnswer).status(), 200);
  await mobileQuestions.locator('#answer-list').getByText('A stranger held the door.', { exact: true }).waitFor();
  await shot(mobileQuestions, 'questions-mobile-populated.png');
  seed(db => {
    const insert = db.prepare('INSERT INTO questions_items(created_at, body) VALUES (?, ?)');
    for (let i = 0; i < 13; i++) insert.run(Date.now() - i, `A test-only question from the archive, number ${i + 1}?`);
  });
  await questions.goto(`${base}/questions`);
  await questions.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await questions.getByRole('button', { name: 'Older questions' }).waitFor();
  const olderQuestionPage = questions.waitForResponse(response => response.url().includes('/api/questions?before='));
  await questions.getByRole('button', { name: 'Older questions' }).click();
  assert.equal((await olderQuestionPage).status(), 200);
  assert.ok((await questions.locator('#question-list li').count()) > 0);
  await shot(questions, 'questions-desktop-older-page.png');

  // The Choice: one question, two direct choices, private-until-voted totals, then a small archive.
  const choice = await open(desktopContext, '/choice');
  await choice.getByRole('heading', { name: 'The Choice' }).waitFor();
  await choice.locator('#choice-empty').waitFor({ state: 'visible' });
  await shot(choice, 'choice-desktop-empty.png');
  if (!(await choice.locator('#proposal-panel').evaluate(element => element.open))) {
    await choice.getByText('Suggest a future question', { exact: true }).click();
  }
  await choice.locator('#proposal-question').fill('Which way home?');
  await choice.locator('#proposal-a').fill('By the water');
  await choice.locator('#proposal-b').fill('Through the trees');
  await shot(choice, 'choice-desktop-interaction.png');
  const proposalResponse = choice.waitForResponse(response => response.url().endsWith('/api/choice/proposals') && response.request().method() === 'POST');
  await choice.getByRole('button', { name: 'Suggest it' }).click();
  const proposalStatus = await proposalResponse;
  assert.equal(proposalStatus.status(), 200);
  const proposalPayload = await proposalStatus.json();
  const decisionId = proposalPayload.decision.id;
  await choice.getByRole('heading', { name: 'Which way home?' }).waitFor();
  assert.equal(await choice.locator('#choice-results').isVisible(), false);
  await shot(choice, 'choice-desktop-populated.png');
  const desktopVote = choice.waitForResponse(response => response.url().endsWith(`/api/choice/decisions/${decisionId}/vote`));
  await choice.getByRole('button', { name: 'By the water' }).click();
  assert.equal((await desktopVote).status(), 200);
  assert.deepEqual(await choice.locator('#option-a').getAttribute('aria-pressed'), 'true');
  const changeVote = choice.waitForResponse(response => response.url().endsWith(`/api/choice/decisions/${decisionId}/vote`));
  await choice.getByRole('button', { name: 'Through the trees' }).click();
  assert.equal((await changeVote).status(), 200);
  assert.equal(await choice.locator('#results-count').textContent(), '1 vote');
  assert.match(await choice.locator('#result-count-b').textContent(), /100%/);

  const mobileChoice = await open(mobileContext, '/choice');
  await mobileChoice.getByRole('heading', { name: 'Which way home?' }).waitFor();
  assert.equal(await mobileChoice.locator('#choice-results').isVisible(), false, 'another visitor cannot see totals before voting');
  await shot(mobileChoice, 'choice-mobile-populated.png');
  const mobileVote = mobileChoice.waitForResponse(response => response.url().endsWith(`/api/choice/decisions/${decisionId}/vote`));
  await mobileChoice.getByRole('button', { name: 'By the water' }).click();
  assert.equal((await mobileVote).status(), 200);
  await mobileChoice.locator('#choice-results').waitFor({ state: 'visible' });
  await shot(mobileChoice, 'choice-mobile-interaction.png');
  if (!(await mobileChoice.locator('#proposal-panel').evaluate(element => element.open))) {
    await mobileChoice.getByText('Suggest a future question', { exact: true }).click();
  }
  await mobileChoice.locator('#proposal-question').fill('Which sound should stay?');
  await mobileChoice.locator('#proposal-a').fill('Rain on a roof');
  await mobileChoice.locator('#proposal-b').fill('Waves at night');
  const queuedProposal = mobileChoice.waitForResponse(response => response.url().endsWith('/api/choice/proposals') && response.request().method() === 'POST');
  await mobileChoice.getByRole('button', { name: 'Suggest it' }).click();
  assert.equal((await queuedProposal).status(), 200);
  await mobileChoice.getByRole('heading', { name: 'Which way home?' }).waitFor();
  assert.equal(await mobileChoice.locator('#decision-question').textContent(), 'Which way home?', 'queued suggestions do not replace the active choice');
  const queuedState = await (await fetch(`${base}/api/choice/state`)).json();
  assert.equal(queuedState.active.id, decisionId);
  assert.equal(queuedState.queuedCount, 1);

  seed(db => {
    const closesAt = Date.now() - 1000;
    const openedAt = closesAt - 7 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE choice_decisions SET created_at=?, opened_at=?, closes_at=? WHERE id=? AND status=?')
      .run(openedAt - 1000, openedAt, closesAt, decisionId, 'active');
  });
  const afterClose = await (await fetch(`${base}/api/choice/state`)).json();
  assert.equal(afterClose.active.question, 'Which sound should stay?');
  assert.equal(afterClose.active.status, 'active');
  await choice.reload();
  await choice.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await choice.locator('#archive-panel summary').click();
  await choice.locator('#choice-archive li').first().waitFor();
  await choice.getByText('Which way home?', { exact: true }).last().waitFor();
  await shot(choice, 'choice-desktop-closed-archive.png');

  for (const page of [guestbook, guestbookMobile, story, mobileStory, boundaryPage, questions, mobileQuestions, choice, mobileChoice]) {
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(widths.document <= widths.viewport, `${page.url()} horizontal overflow: ${JSON.stringify(widths)}`);
  }
  assert.deepEqual(errors, [], 'new space pages render without uncaught browser or console errors');
  console.log('PASS four distinct spaces: desktop/mobile writing, stale story review, question answers, private vote results, lifecycle archive, and saved screenshots');
} finally {
  await mobileContext.close();
  await desktopContext.close();
  await otherWriterContext.close();
  await boundaryContext.close();
  await browser.close();
}
