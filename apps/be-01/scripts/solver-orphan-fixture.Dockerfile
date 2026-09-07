ARG SOLVER_BASE_IMAGE
FROM ${SOLVER_BASE_IMAGE}

COPY apps/be-01/scripts/solver-orphan-fixture.sh /usr/local/bin/wbs-solver
RUN chmod 0755 /usr/local/bin/wbs-solver
