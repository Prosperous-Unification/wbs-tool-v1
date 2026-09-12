## ADDED Requirements

### Requirement: Public source-run dev keeps browser documents stable

The public dev frontend SHALL serve source on demand without exposing Vite HMR. Local development
and isolated browser gates SHALL retain HMR. A changed source file MUST be served by a fresh browser
request after the dev checkout advances.

#### Scenario: public browser loses no document to an HMR reconnect

- **WHEN** a public dev page remains open while its environment closes long-lived WebSockets
- **THEN** the page is not reloaded by the Vite client and every post-readiness body sample remains
  non-empty for two minutes

#### Scenario: local development keeps live updates

- **WHEN** fe-01 serves without the public-dev process flag
- **THEN** Vite's HMR default remains enabled

#### Scenario: a source deploy is still visible

- **WHEN** the dev poller advances the checkout to a commit that changes frontend source
- **THEN** a fresh browser request receives the changed source without an image build or container
  restart

### Requirement: Browser stability probes fail on navigation

A browser stability probe SHALL sample one page inside one uninterrupted evaluation after readiness.
Navigation or any empty post-readiness body sample MUST fail the probe rather than become assertion
input.

#### Scenario: a reload interrupts the probe

- **WHEN** the page navigates after readiness and before the final sample
- **THEN** the probe fails because its execution context was destroyed
