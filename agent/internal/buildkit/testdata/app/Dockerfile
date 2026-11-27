# Built by real_buildkit_test.go from this repository at its commit (ADR 0030).
FROM busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
ARG GREETING=hello
# A build step reaches neither the Docker socket nor the host's root.
RUN test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && test ! -e /host
COPY greeting.txt /greeting.txt
RUN echo "$GREETING from $(cat /greeting.txt)" > /built.txt && cat /built.txt
# The image runs as an unprivileged user, as any application image should.
USER nobody
CMD ["cat", "/built.txt"]
