# PRD: Company of Bots

| | |
|---|---|
| Status | Draft, decisions locked in design review on 2026-11-11. Amended the same day after two council reviews: §2, §3.2, §4, §5, §6, §8.1, §10.2, §10.3, §11.1, §15, §17, §19, §20.19, §20.20, §23 |
| Working title | Company of Bots. The product name is not chosen. |
| Audience for this document | The person building version one |
| What this is | A local engine plus one agent. The agent's job is to get that user hired. |
| What this is not | A hosted service, a software-job product, or a copy of any one person's tracker |

This document is the product. It does not specify languages, frameworks, or file formats except where a format is itself a product rule (git, localhost, secrets kept out of git).

---

## 1. Problem

People who are hunting for work lose applications in the gap between "the bot can fill this" and "a human has to finish this." The human is sent into a chat, asked one parked item at a time, and often has to drive a computer that belongs to the bot.

That gap is worse when the work is not one occupation. A person with a trade, a care job, a design practice, or a software career should be able to use the same company of bots. The product must not ship one occupation's boards, titles, or stock answers.

The user also cannot see the whole search in one place. Profile, resumes, parked items, companies worth watching, the day's list, and what the bots did are scattered across chats and files.

## 2. Outcome

A person installs the engine on their own computer, talks to an interviewer, and connects one agent. From a localhost app they can:

- see and extend the profile through interviews
- see every resume and choose the master
- see open roles the Finder brought back, and keep a list of companies that have no open role yet
- clear parked applications without opening the bot's screen
- record a status or tick the day's list
- see what each role did

The agent clones their private data, runs on its own schedule, and uses its own browser. The user never operates that screen.

## 3. Users

### 3.1 Primary user

Any person with skills who wants help getting hired. They are not assumed to know git, bots, or a particular career. One install is one user. There is no shared login and no multi-user server.

### 3.2 Operator of the agent

The same person, or someone they trust, who can run the reference agent on a machine they control. By default that machine is the same computer as the app. The agent runs there as its own process, with its own browser profile, which the user does not operate. Running the agent on another machine is optional. The localhost wizard hides git commands. It does not hide the fact that the agent has to be started once.

### 3.3 Explicitly not a user of someone else's data

The author of this product is not the customer. Their existing tracker, question bank, passwords, and board list are not imported and are not in the public repo.

## 4. Locked principles

1. The public repo is code. Each user has a private git remote for their data.
2. The UI binds to localhost. There is no shared server.
3. The user never opens the bot's screen.
4. The engine does not click Apply and does not include its own model. The agent is the only interviewer and the only applier.
5. The agent stores only what the user said and what is on a resume the user handed over. It does not invent jobs, skills, or answers.
6. An interview is the only way to add or change the profile and the question bank.
7. Interviews are unlimited. The first one ends when the minimum set in section 8.2 is captured. Later ones may be short.
8. Every stored point has a confidence score. Only a confirmed point may be sent on an application. A weak or unsure point is asked again.
9. Website forms are the only thing the Applier submits. Email, phone, and in-person applications stay on the Inbox for the user.
10. CAPTCHA is not solved and not relayed. That item stays parked until the user finishes it themselves and marks it done, or drops it.
11. Cookies and passwords never enter either git repo. Cookies for one site move from the user's browser to the agent on a private channel.
12. The agent keeps its own schedule. The app does not turn routines on or off and does not edit the agent's playbook source.
13. Version one ships one reference adapter. Another bot is another adapter against the same files. Grok is not required.
14. No occupation pack. A new kind of work needs no code change.

## 5. Non-goals for version one

- Publishing to LinkedIn or any social network
- Sending email or placing phone calls
- Solving, relaying, or bypassing CAPTCHA
- Typing or storing a password
- Automatic selection of companies from funding, news, or similar signals
- A preset list of job boards
- Importing an existing personal tracker
- A dashboard of anyone else's numbers
- Rewriting git history to erase a transcript
- More than one agent adapter
- A hosted multi-tenant app
- Editing the agent's playbook as source code from the UI

Funding, news, and other "company looks promising even with no opening" signals are deferred research. The company list itself ships (section 10).

## 6. System context

```
localhost app  ----reads/writes---->  local checkout of the private repo
       |                                        |
       | push (profile, points, transcripts,    | pull
       | commands, tracker, resumes, sources)   |
       v                                        v
 private git remote  <--------------------    agent
       ^                                        |
       |                                        | clones
 public engine repo  ----------------------------+

 private channel (not git): cookies, wake token
```

Three processes:

| Process | Where it runs | Owns |
|---|---|---|
| Engine UI | User's computer, localhost | Screens, interview transcript display, Connect, Save, Run now |
| Private data repo | User's git host, private | Points, scores, transcripts, resumes, tracker, sources, companies, commands |
| Reference agent | A machine the user controls, by default the same computer (§3.2) | Browser, schedule, the five roles |

The agent clones the public engine and the private data repo into its own checkout. It never reads the app's checkout directly. An agent on the same computer still syncs through the private remote, which is also the user's backup. The user's computer never serves the UI to the network.

### 6.1 Two speeds

| Action | What is written | When it runs |
|---|---|---|
| Save | A command in the private repo, then a push | The agent's next scheduled run |
| Run now | The same command and push. If a wake token is configured, the app wakes the agent. | Immediately when the wake succeeds. If no token is set, behavior matches Save. |
| Agent already busy | The command stays queued. The app shows that a run holds the lock and until when, when the agent reports that. | The queued command runs when the lock is free, or on the next schedule. |

Record-only actions (status, daily tick, drop, done) still go through this path. The app does not write tracker outcomes by a side door that the agent will also write.

### 6.2 What works with no agent connected

The user can read the local checkout: profile, points, transcripts, resumes, tracker, companies, sources, and the dashboard counts that can be computed from those files. They can draft an interview's notes only by talking to the agent. They cannot complete an interview, submit an application, or refresh cookies until the agent is awake.

## 7. Roles

One agent performs all five. Version one is not five servers.

| Role | Does | Does not |
|---|---|---|
| Interviewer | Text interview in the app. Writes points, scores, bank entries, sources, and the resume the user handed over. | Invent facts. Fill an application. |
| Finder | Reads enabled sources. Records open roles that match confirmed points. | Submit. Auto-add companies from news or funding. Use a source the user did not turn on. |
| Applier | Opens a website form, fills confirmed points, uploads the master resume, submits, or parks. | Use an unconfirmed point. Send email. Call. Solve CAPTCHA. Type a password. |
| Inbox | Turns the agent's parks into rows. Hosts one interview for every missing answer in the current parked set. Hosts the row buttons. | Write the question bank except through the Interviewer. |
| Guide | Shows the daily lanes and accepts ticks. | Ship a personal exercise or income plan. |

## 8. Interviewer

### 8.1 Channel

- The interview is a text conversation on the first screen and on later screens that start an interview.
- The agent asks and writes. The engine does not call a second model.
- If the agent is not running, the app uses the wake token when one is set, then starts the conversation.
- Git commands are not shown.
- Nothing from an interview is stored until the user reviews it. The app shows each point the agent proposes next to the user's own words it came from, and stores only the points the user accepts. The transcript and files saved with the interview are the app's own record of the conversation, not a copy the agent supplies.

### 8.2 First interview

The first interview ends when all of the following exist:

| Minimum | Rule |
|---|---|
| Work they want | Their words |
| Skills to use | Their words |
| Places | Their words, including remote or a city if they say so |
| Hard nos | Their words. Empty is allowed if they explicitly say they have none. |
| One resume | A file they handed over in the conversation |
| Where to look | At least one source they chose to enable, or an explicit "decide later" that leaves the source list empty |

The agent may ask follow-ups inside this interview. It stops when the minimum set is stored. It offers another interview. It does not keep the user in the introduction after the set is complete.

### 8.3 Later interviews

There is no cap.

A later interview starts when:

- the user asks to update the profile, from the profile screen, or
- the Inbox has one or more missing answers, or
- the user opens a weak point from the profile list

The agent asks only the gap that started the interview, plus anything the user volunteers. It does not replay the whole introduction unless the user asks to start over.

### 8.4 What may be stored

A point is one fact. Examples: a kind of work, a skill, a place, a hard no, a source, an answer to an application question.

| Source of the point | Stored? | Starting confidence |
|---|---|---|
| User stated it in an interview | Yes | Confirmed |
| Line on a resume the user handed over | Yes | Confirmed |
| User says they are unsure | Yes, marked unsure | Not sendable |
| Agent inference or guess | No | — |

The agent may ask a question that occurred to it. Until the user answers, that question is not a point.

### 8.5 Question bank

The question bank is the set of points that answer application fields (label, answer, any instruction the user gave, confidence).

- Create and update only inside an interview.
- A one-line box on an Inbox row does not write the bank.
- All missing answers for the current parked items are a single interview. The agent asks them in that sitting. Each answer becomes its own point.
- The same confidence rules as the profile apply.
- Reuse is by meaning of the field, not by one employer. A confirmed answer may be reused on a later form with the same question. The agent does not stretch an answer onto a different question.

### 8.6 Confidence

The product rules are ordered states, not a named formula. An implementation may store a number. The number must preserve this order, and the UI must not require the user to edit the number.

| Event | Result |
|---|---|
| User states a fact, or the resume contains it | Point exists at Confirmed |
| User confirms it again in a later interview | Rank within Confirmed rises |
| User corrects it | New wording replaces the old point. Rank resets to the starting Confirmed. The old wording is not kept as a second truth. |
| User is unsure | Rank drops below Confirmed. The point is not sendable. |
| Agent is about to guess | Nothing is stored |

The profile lists points lowest rank first. The Applier may place a point on a form only when its rank is Confirmed or higher. Anything lower becomes a question in an interview instead of a filled field.

The user sees the rank. They change it by answering, confirming, correcting, or saying they are unsure. There is no numeric keypad.

### 8.7 Transcripts

- The full transcript of each interview is pushed to the private repo, with the points and scores from that interview.
- The profile lists interviews. The user can open a transcript.
- Remove deletes that transcript from the current version of the repo and pushes the deletion.
- Points that came from it stay until an interview corrects or removes them.
- The app does not rewrite or force-push history. A transcript that was pushed remains readable from older commits. The UI says so before the user removes one.

### 8.8 Resume handoff inside an interview

The user can hand over a resume file in the conversation. The first interview requires one. A later interview may add another. Files are stored in the private repo. Choosing which file is the master is a profile action (section 12), not a separate interview, unless the user wants the agent to ask.

## 9. Finder

### 9.1 Sources

- Setup and the profile show a source list the user edits.
- The public repo ships the list empty, plus one commented example of a careers-page URL. The example names no real employer and no occupation board.
- Finder reads only rows the user has turned on.
- The user can add, pause, or remove a source in the profile. Adding a source may happen inside an interview ("look here") or from the list. Both write the same source record.

### 9.2 Open roles

For each enabled source, Finder records roles that fit the confirmed points (work, skills, places, hard nos). A hard no excludes a role. An unsure point does not act as a filter and does not act as a qualification.

Each open-role record shows: title, organization, location if known, source, link, and the date it was found. The user can dismiss it. Dismissed roles are not shown as new again.

Finder does not submit.

### 9.3 Companies with no open role

A company list exists in version one.

- The user adds, keeps, or dismisses a company by hand.
- A row is a name, an optional note in the user's words, an optional link, and the date.
- Nothing is submitted from this list.
- Finder does not auto-create rows from funding, news, headcount, or similar signals in version one.
- When an open role later appears at a company on this list, Finder records the role in the normal way and the company row remains.

## 10. Applier

### 10.1 What it may submit

A page on a website that has fields and a place to put the resume. The agent uses the master resume and confirmed points only.

### 10.2 What it does when blocked

| Block | Result on the Inbox |
|---|---|
| Field with no confirmed point | Parked as missing answer. Included in the next Inbox interview. |
| Sign-in wall, and no usable cookie for that site | Parked as sign-in. Row offers Connect. |
| Email or SMS code required | Parked as code. If this run is still on the page, the row becomes a paste box. If the run has already closed the page, the row stays parked and Run now can request a fresh code later. |
| CAPTCHA | Parked as captcha. No solver, no image relay. |
| "Confirm your email" link | Parked as verify. The user clicks the link in their own mail. The row has a Verified button. |
| The application is an email address, a phone number, an instruction to show up in person, or a step only the user can do, such as a take-home assessment | Parked as human. The user finishes it outside the product. |
| A technical failure before the submit click: an upload fails, a page does not load, or a field will not take input | Parked as error, with the agent's note. Retry is safe. |
| A technical failure at or after the submit click: an error page, a timeout, or a run that stopped before it recorded the result | Parked as error, marked "may have been sent". Retry runs only after the user says it was not sent. |
| User hard no matches the role | Not submitted. Recorded as skipped, with the hard no that matched. |

The agent leaves no requirement that the user open the bot's browser. After a park, the page on the agent may close. A live code is the exception: the paste box exists only while the agent reports it is still on that page.

### 10.3 Submit record

A submission stores: organization, title, link, source, resume file used, timestamp, and the points that were sent (identifiers, not a second copy of the prose that can drift). The tracker is the agent's write, after the run, into the private repo. Before the submit click, the agent records what it is about to send, so a run that stops after the click still leaves a record. That record becomes an error row marked "may have been sent".

## 11. Inbox

The Inbox is the pending list. It is one screen, not a chat scavenger hunt.

### 11.1 Row types and actions

| Row type | Interview | Buttons |
|---|---|---|
| Missing answer | Yes, batched with every other missing answer currently parked | Drop |
| Sign-in | No | Connect, Drop |
| Code, and the agent is waiting | No | Paste code, Drop |
| Code, and the agent is not on the page | No | Run now (requests a fresh code), Drop |
| Verify email | No | Verified, Drop |
| Captcha | No | Done, Drop |
| Human (email, phone, in person, an assessment) | No | Done, Drop |
| Error before the submit click | No | Done, Drop |
| Error after the submit click (may have been sent) | No | Done (it was sent: recorded as submitted), Drop. Retry asks first whether it was sent. |
| Any parked row | No | Status, Retry, Drop |

Done means the user finished it themselves. Drop means stop tracking it. Retry puts it on the next run after a cookie refresh or a new answer. Verified means the user completed the mail confirmation. Status is a short note on that application (recruiter reply, interview time, rejection, offer). Status does not publish anywhere.

### 11.2 The missing-answer interview

- One action starts it: "Answer these."
- The agent asks every missing field in the current parked set, in one conversation.
- The user can stop midway. Answered fields become confirmed points. Unanswered fields stay parked.
- On completion, the app writes the interview (points, scores, transcript) and a retry command for each application that now has confirmed answers, then pushes.
- The user chooses Save or Run now for that push.

### 11.3 Live code

- The box is on the row.
- It is shown only while the agent reports it is waiting on that page.
- The pasted code is sent on the private channel to the waiting run, not committed.
- If the user does not paste in time, the agent parks the row and closes the page. The code is not stored.

## 12. Resumes and profile screen

The profile screen shows:

- points, lowest rank first, with their rank and sendable / not sendable state
- interviews, with open and remove
- resumes, with open, and a single Master marker
- sources
- hard nos and the rest of the minimum set, as points

Master: the Applier uploads the file marked Master. Marking a different file is immediate in the data repo (a profile save and push) and applies on the next run. The screen lists every resume file in the private repo, including files attached to past applications.

The user can start an interview from this screen at any time.

## 13. Guide

Three lanes exist on a new install. The user can rename, delete, or add lanes.

| Starting lane | Meaning |
|---|---|
| People they owe | A reply the user still has to send |
| Applications waiting on them | Inbox work, restated as a daily item |
| One outreach | One person or organization to contact |

No exercise plan, income plan, or other personal routine is shipped.

A tick is Done or Skip for that lane on that day. Ticks are commands pushed like other record-only actions. The agent writes the day log. The user can tick with Save. Run now is available and not required.

## 14. Dashboard

Computed from this user's private repo only.

| Figure | Meaning |
|---|---|
| Role ran | Each role, and the last time it completed a run |
| Submitted | Applications the Applier submitted in the selected range |
| Parked | Inbox rows created in the range, by row type |
| Responses | Status notes that record a human reply, interview, rejection, or offer |

The default range is the trailing seven days, with a control for another range. Empty data shows zeros and the last-run time, not sample numbers.

The dashboard does not include a single "profile completeness percent" that gates the product. The profile screen's ranked points are the completeness view.

## 15. Command contract

The private repo is the contract. Adapters translate it. Screens do not name a vendor.

A command record has:

| Field | Required |
|---|---|
| Id | Yes |
| Created at | Yes |
| Verb | Yes |
| Target | Application id, lane id, or empty for a global command |
| Payload | Verb-specific |
| State | Queued, done, failed |
| Result note | Written by the agent |

Verbs in version one:

| Verb | Who emits it | Agent does |
|---|---|---|
| `interview_saved` | App, after an interview | Already persisted by the interview write. The agent reloads points. Included so a wake has a command to chew on. |
| `retry` | Inbox | Open that application again. On a "may have been sent" row, only after the user says it was not sent. |
| `done` | Inbox | Close the row as finished by the user |
| `drop` | Inbox | Close the row as abandoned |
| `verified` | Inbox | Retry a verify-email row |
| `status` | Inbox or an application | Append the note to that application |
| `lane_done` / `lane_skip` | Guide | Write the day log |
| `run_role` | Run now, optional | Run Finder, Applier, or Guide now. Interviewer is woken by the interview screen, not by this verb. |

The live code paste and the cookie delivery are not verbs. They are private-channel messages and are not written to the repo.

The agent processes queued commands oldest first, then does its scheduled role work. It marks each command done or failed with a note. It does not delete history.

### 15.1 Lock

One run at a time on the reference agent. A second wake receives "busy until …" and does not start a parallel browser session.

## 16. Connect and cookies

On a sign-in row the user presses Connect and signs in on that site in their own browser. The localhost app sends that site's cookies to the agent on the private channel. The agent loads them into its browser and retries according to Save or Run now.

Rules:

- One site per Connect.
- Cookies for other sites are not read.
- Cookies are not written to the public repo, the private repo, the transcript, or the command log.
- The app does not ask for or type the password.
- If the agent reports the session was rejected, the row returns to sign-in and Connect is offered again.

How the localhost app reads the cookies out of the browser is an open implementation choice (section 21). The behavior above is not optional.

## 17. First-run experience

1. User opens localhost.
2. The app creates or links their private repo without asking them to type git commands. It asks where they want the private remote only if it cannot create one, and it explains that choice in one sentence.
3. The app shows one step to start the agent, and where to put the wake token if they want Run now.
4. The first screen becomes the introductory interview (section 8.2).
5. After the minimum set exists, the home screen is the dashboard, with Inbox, Profile, Finder (roles and companies), Guide, and Resumes reachable.

A user who stops during the first interview can resume it. Partial confirmed points are kept.

## 18. Privacy and security

| Data | Public repo | Private repo | Machine only | Private channel |
|---|---|---|---|---|
| Engine code | Yes | No | Checkout of public code on the agent | No |
| Points, scores, bank | No | Yes | Checkout | No |
| Transcripts | No | Yes | Checkout | During the interview |
| Resumes | No | Yes | Checkout | No |
| Tracker, sources, companies, commands | No | Yes | Checkout | No |
| Cookies | No | No | Agent browser memory after delivery | Yes |
| Passwords | No | No | Never stored | No |
| Wake token | No | No | Localhost secret store | Used only to wake |

The UI states, in normal language, that the private repo contains the interviews and the resume, and that a removed transcript can remain in old commits.

Localhost is loopback only. The app refuses to bind a non-loopback address in version one.

## 19. Reference adapter

Version one includes one adapter: an agent the user runs on a machine they control, by default the same computer as the app (§3.2).

It must:

- clone the public engine and the user's private repo
- pull before a run and push its writes after a run
- run Finder, Applier, Inbox processing, Guide, and Interviewer
- keep a schedule the app does not edit
- open its own browser and reuse that browser profile
- accept cookies and a live code on the private channel
- accept a wake when a token is configured
- honor the lock in section 15.1
- park by the table in section 10.2
- refuse to type a password or solve a CAPTCHA

A later adapter implements the same contract. The screens do not change.

## 20. Acceptance scenarios

### 20.1 New user, any occupation

Given a clean install, when the user finishes the first interview with the minimum set, then the profile shows those points as Confirmed, the resume is Master, the source list contains only what they enabled, and no occupation sample data appears.

### 20.2 No invention

Given the user never said they worked at a place, when the interview ends, then that place is not a point, even if the agent mentioned it as a question.

### 20.3 Weak point is not submitted

Given a point the user marked unsure, when the Applier reaches a field that point would answer, then the field is parked as a missing answer and the unsure text is not typed into the form.

### 20.4 Correction

Given a confirmed skill, when the user corrects it in a later interview, then only the new wording is sendable and its rank is the starting Confirmed rank.

### 20.5 Unlimited interviews

Given an existing profile, when the user starts an interview from the profile on two different days, then both transcripts are in the private repo and both are listed.

### 20.6 Batched bank interview

Given three parked missing answers, when the user runs "Answer these" and answers all three, then three confirmed bank points exist, one transcript exists, and three retry commands are queued.

### 20.7 Buttons are not interviews

Given a captcha row, when the user marks Done, then no transcript is created and the row closes as finished by the user.

### 20.8 Live code

Given the agent is waiting on a code, when the user pastes it, then the code is sent on the private channel, the repo has no copy of the code, and the agent types it on the page.

Given the user does not paste before the agent stops waiting, when they return, then the row is parked and the paste box is gone.

### 20.9 Captcha

Given a captcha, when the run parks, then the Inbox shows Done and Drop, and the product shows no captcha image and no solver.

### 20.10 Connect

Given a sign-in row, when the user connects that site, then only that site's cookies are sent, the private repo diff contains no cookie, and a later retry can pass the sign-in wall if the site accepts the session.

Given the site rejects the session, when the agent reports that, then the row is sign-in again.

### 20.11 Human application

Given a role whose only path is an email address, when Finder stores it, then the Inbox row is human, and the agent does not send mail.

### 20.12 Company list

Given the user adds a company with no opening, when Finder next runs, then no application is submitted for that company. An open role found later is a normal role record.

### 20.13 Empty sources

Given no source is enabled, when Finder runs, then it records nothing and does not query a default board.

### 20.14 Save and Run now

Given no wake token, when the user chooses Run now, then the command is pushed and the app says it will run on the next schedule.

Given a wake token and an idle agent, when the user chooses Run now, then the agent starts without the user opening its screen.

Given a busy agent, when the user chooses Run now, then the app shows the lock and the command stays queued.

### 20.15 Transcript removal

Given a pushed transcript, when the user removes it and confirms the history warning, then the file is absent from the current tree, the points remain, and an older commit still contains the transcript.

### 20.16 Guide defaults

Given a new private repo, when the user opens Guide, then the three starting lanes are present and deletable, and no other personal routine is present.

### 20.17 Isolation

Given two installs, when each dashboard loads, then each shows only its own private repo.

### 20.18 Localhost

Given a default install, when the app starts, then it listens on loopback only.

### 20.19 Review before save

Given the agent proposes two points in an interview and the user accepts only one, when the interview is saved, then only the accepted point is stored, and the transcript in the private repo is the app's own record of the conversation.

### 20.20 Technical failure

Given an upload fails before the submit click, when the run parks, then the Inbox row is error, shows the agent's note, and offers Retry.

Given the page shows an error after the submit click, or the run stops after the click, when the Inbox shows the row, then it says the application may have been sent, Done records it as submitted, and Retry runs only after the user says it was not sent.

## 21. Open implementation choices

These are not product decisions. Any choice that violates a locked principle is wrong.

| Topic | Constraint the choice must meet |
|---|---|
| Numeric encoding of confidence | Order in section 8.6. User never types the number. |
| How localhost reads one site's cookies | Section 16. No other site. No git. |
| Git host for the private remote | User's own host. Wizard hides commands. |
| Wake transport | Token stays in the local secret store. No token means schedule-only. |
| On-disk layout inside the private repo | Must round-trip every field in this PRD. Adapters may translate. |
| Visual design | Localhost app with the screens in this PRD. |
| Product name and license | Unset. Do not block the data contract on them. |
| Exact schedule of the reference agent | The agent's. The app displays the last run and the next run if the agent reports them. |

## 22. Deferred research

Company signals (latest funding, news, and anything similar) are out of version one. When that research exists, it comes back as a proposal to add optional, user-visible signals on the company list. It does not change the rule that a company row does not submit an application.

## 23. Glossary

| Term | Meaning |
|---|---|
| Engine | The localhost app and the data contract |
| Agent | The separate process that runs the five roles, by default on the same computer as the app |
| Point | One stored fact with a confidence rank |
| Confirmed | Sendable on an application |
| Bank | Points that answer application questions |
| Inbox | Parked work |
| Connect | Move one site's cookies to the agent |
| Save | Push a command for the next scheduled run |
| Run now | Push, then wake if a token exists |
| Master | The resume file the Applier uploads |
| Private channel | Path for cookies, live codes, and the wake. Not git. |
