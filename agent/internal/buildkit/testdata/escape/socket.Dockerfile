# Built by real_samples_test.go: a bind mount reads the repository, never the host (#215).
FROM busybox:1.37.0@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
RUN --mount=type=bind,source=/var/run/docker.sock,target=/docker.sock echo "reached" "the host"
USER nobody
