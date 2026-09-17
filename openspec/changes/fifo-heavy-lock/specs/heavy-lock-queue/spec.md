## ADDED Requirements

### Requirement: Waiters take the heavy lock in arrival order

A run that cannot claim the heavy lock SHALL enqueue a ticket naming its pid, lane label, command
and start time, and SHALL claim the lock only while no live ticket that arrived earlier is queued.
A run that claims the lock SHALL delete its own ticket.

#### Scenario: A faster-polling waiter arrives second

- **WHEN** a holder is running, waiter A enqueues, and waiter B enqueues a second later with a
  shorter poll interval
- **THEN** A runs its command before B does, although B polls the released lock first

#### Scenario: A run takes a free lock

- **WHEN** nothing holds the lock and no ticket is queued
- **THEN** the run claims it without waiting and leaves neither its ticket nor the lock behind

### Requirement: A dead waiter never holds the queue

A ticket SHALL record the instant its owner stops waiting. A ticket whose pid no longer exists, or
whose recorded deadline passed more than a minute ago, SHALL be removed by whichever run sees it
first, naming the ticket on stderr. A waiter SHALL remove its own ticket when it claims the lock,
when it is refused, and when it exits, is interrupted or is terminated.

#### Scenario: A waiter is killed while queued

- **WHEN** a ticket that arrived earlier names a pid that has exited
- **THEN** the next run removes that ticket, names it on stderr, and takes the lock rather than
  queueing behind a process that will never release it

#### Scenario: A killed waiter's pid is reused by an unrelated process

- **WHEN** a ticket names a live pid but its own wait budget expired more than a minute ago
- **THEN** the next run removes that ticket, saying how long ago the budget expired, rather than
  queueing behind a ghost for ever

#### Scenario: A run gives up or claims

- **WHEN** a run takes the lock, or is refused at its wait budget
- **THEN** it leaves no ticket in the queue, so nothing queues behind a run that is no longer
  waiting

#### Scenario: A signalled run stops

- **WHEN** a run is sent INT or TERM
- **THEN** it leaves no ticket, runs once the exit trap it inherited, and exits 130 or 143 rather
  than cleaning up and carrying on as a waiter with no ticket
- **AND** a run that already holds the lock lets its command finish first, then releases and exits

#### Scenario: A run is killed while writing its ticket

- **WHEN** a half-written ticket is left behind by a run that no longer exists
- **THEN** the next run removes it, naming it, rather than leaving a file no queue reader will
  ever look at again

### Requirement: The queue reports who holds the lock and who waits

`bin/with-heavy-lock.sh status` SHALL print the holder's pid and lane label and then every queued
ticket oldest first with its pid, lane label and age in seconds. Every run that claims the lock
SHALL print how many whole seconds it waited and how many tickets were ahead of it when it
enqueued, including when it waited for none. The h2puni gate SHALL label its lane with the commit
it gates.

#### Scenario: Two waiters are queued behind a holder

- **WHEN** status runs while one run holds the lock and two runs wait
- **THEN** it prints the holder's pid and label first, then the two waiters oldest first, one line
  each, and exits 0

#### Scenario: A gate queues behind another holder

- **WHEN** the gate takes the lock after waiting for a holder
- **THEN** it reports its wait in whole seconds before it reports the commit it runs on

#### Scenario: A run gives up behind someone else

- **WHEN** a run is refused because a live ticket that arrived earlier is still queued
- **THEN** the refusal names how many tickets were ahead and their lane labels, rather than
  reporting a holder the free lock does not have
- **AND** a ticket ahead that cannot be named is reported as unknown, distinct from one that has
  left the queue

#### Scenario: The report races a claim it cannot be sure about

- **WHEN** a lock directory has no holder file yet, or a holder recorded no lane label
- **THEN** status says so and exits 0, and refuses with exit 70 only for state it cannot read

### Requirement: Unknown queue state refuses rather than guessing

A run SHALL refuse with exit 70, naming the path, when the queue directory cannot be read or
written, when a queued name is not `<nanoseconds>-<pid>`, and when a ticket records no lane label
or no deadline. A run SHALL refuse with exit 70 when no nanosecond clock is available, rather than
enqueue a ticket that cannot be ordered. A ticket SHALL become visible in the queue only once it
is complete.

#### Scenario: The queue directory is unreadable

- **WHEN** the queue directory exists but the run cannot read or write it
- **THEN** the run refuses with exit 70 naming that directory, instead of reading an empty queue
  and claiming the lock out of order

#### Scenario: An unorderable name sits in the queue

- **WHEN** the queue holds a name that is not `<nanoseconds>-<pid>`
- **THEN** the run refuses with exit 70 naming it, instead of treating it as a dead ticket and
  deleting it

#### Scenario: The lock directory cannot be read by status

- **WHEN** status finds a lock directory whose holder or label it cannot read
- **THEN** it refuses with exit 70 naming the file, instead of reporting a lock with no holder

#### Scenario: A ticket is read while it is still being written

- **WHEN** a run enqueues while another reads the queue
- **THEN** the reader sees the ticket either not at all or complete, never half-written

#### Scenario: State a reader is holding disappears under it

- **WHEN** a ticket, or the holder's own record, is removed between being listed and being read
- **THEN** the reader treats it as gone and carries on, and reports exit 70 only for state that is
  present and unreadable
