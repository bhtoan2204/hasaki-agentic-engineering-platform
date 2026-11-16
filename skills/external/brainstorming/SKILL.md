---
name: brainstorming
description: "Use in analysis, architecture and planning steps before committing to a design: find out what is actually wanted and why, think wide privately, compare a few approaches and state every default you choose."
---

# Brainstorming (workflow-step adaptation)

You are very good at building. You build what you believe the developer
wants, and that belief is usually thinner than it feels. This skill is for
finding out what they actually want, and why, before a design is fixed.

In this platform the conversation happens through the workflow: the task,
the developer decisions, earlier step results and approval comments are what
the developer told you. Questions go through the platform question tool, and
only when the answer changes what gets built.

## First: What Do You Actually Know?

- **Everything that matters is in the request and the decisions.** Say so in
  one line and design.
- **Something non-trivial is missing.** Ask one precise question (platform
  question tool) whose answer changes the design. A guess they can correct
  ("I'm assuming X because Y") often beats a question; mark it as your guess.

## Ground to Cover

Territory, not a script:

- what kind of change this is, and what makes it special
- what success looks like; goals, non-goals and anti-goals (what would make
  this a failure even if it technically works)
- current state: what exists now, what was tried, what earlier steps found
- prior art in the codebase: existing flows, shared logic, conventions
- how it gets made: when there is existing work, build on what it already
  uses. Any choice you make is recorded as your call, never as something the
  developer agreed to.

## Think Wide Privately

Before you propose anything, come up with several approaches and drop the
weak ones, including any that fight what the developer said about why.
Present the comparison (two or three options, trade-offs, your
recommendation) only where it helps the approval decision.

## Size the Work

| Size | Then |
|------|------|
| A quick, clear change | describe it in the result and let the plan be short |
| A project | a written design in the result, detailed enough that a talented builder could plan from it without going back to the developer |

If it is really several independent pieces, say so and propose an order.

## The Written Design

Cover: intent and the why; goals, non-goals, anti-goals; constraints; the
parts of the how the developer decided, as they decided them; your own calls,
marked as yours; what is left to the implementer.

Nothing gets built until the design is approved: the workflow's approval step
is that gate. Planning detail follows the writing-plans skill.

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll fill in sensible defaults" | Good. Say them out loud. A default they never heard is one they couldn't reject. |
| "They approved the idea" | Approval covers what you showed them. |
| "One approach is obvious" | Check the codebase for an existing flow first. |
