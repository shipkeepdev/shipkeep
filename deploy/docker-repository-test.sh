#!/usr/bin/env bash

check_docker_repository() (
  set +e
  local installer=$1 apt_dir=$2 status signal expected replacement existing path
  local sources=$apt_dir/sources.list.d/shipkeep-docker.sources keyring=$apt_dir/keyrings/shipkeep-docker.gpg
  local legacy_keyring=$apt_dir/keyrings/shipkeep-docker.asc
  mkdir -p -- "$apt_dir/sources.list.d" "$apt_dir/keyrings" || exit

  run_docker_install "$installer" "$apt_dir" fail-download
  status=$?
  [[ $status == 100 ]] || die "Docker download failure returned $status"
  grep -q 'Simulated Docker download failure' "$apt_dir/output" || die 'Docker download was not reached'
  [[ ! -e $sources && ! -e $keyring ]] || die 'a failed download left repository files behind'

  run_docker_install "$installer" "$apt_dir" fail-update
  status=$?
  [[ $status == 100 ]] || die "Docker repository update failure returned $status"
  grep -q 'Simulated Docker repository update failure' "$apt_dir/output" || die 'Docker repository update was not reached'
  [[ ! -e $sources && ! -e $keyring ]] || die 'a failed repository update left repository files behind'

  for signal in HUP TERM; do
    run_docker_install "$installer" "$apt_dir" "signal-$signal"
    status=$?
    if [[ $signal == HUP ]]; then expected=129; else expected=143; fi
    [[ $status == "$expected" ]] || die "Docker download interrupted by $signal returned $status"
    grep -q 'Simulated Docker download interruption' "$apt_dir/output" || die 'Docker download was not interrupted'
    [[ ! -e $sources && ! -e $keyring ]] || die "a download interrupted by $signal left repository files behind"
    [[ -z $(find "$apt_dir" -name '.shipkeep-docker.*' -print -quit) ]] || die "a download interrupted by $signal left drafts behind"
  done

  for replacement in sources keyring; do
    run_docker_install "$installer" "$apt_dir" "replace-$replacement"
    status=$?
    [[ $status == 100 ]] || die "a replaced Docker $replacement returned $status"
    if [[ $replacement == sources ]]; then
      grep -Fxq -- 'replacement repository' "$sources" || die 'a replacement repository was removed'
      [[ ! -e $keyring ]] || die 'an unchanged keyring was not rolled back'
      rm -- "$sources"
    else
      grep -Fxq -- 'replacement keyring' "$keyring" || die 'a replacement keyring was removed'
      [[ ! -e $sources ]] || die 'an unchanged repository was not rolled back'
      rm -- "$keyring"
    fi
  done

  run_docker_install "$installer" "$apt_dir" fail-apply
  status=$?
  [[ $status == 100 ]] || die "Docker package application failure returned $status"
  grep -q 'Simulated Docker package application failure' "$apt_dir/output" || die 'Docker package application was not reached'
  grep -Fxq -- "Signed-By: $keyring" "$sources" || die 'package application failure removed the update source'
  grep -Fxq -- 'test Docker keyring' "$keyring" || die 'package application failure removed the signing key'
  rm -- "$sources" "$keyring"

  run_docker_install "$installer" "$apt_dir" appear-during-setup
  status=$?
  [[ $status == 1 && ! -e $keyring ]] || die 'a conflict during setup did not roll back the new keyring'
  grep -Fxq -- 'late repository' "$sources" || die 'a repository added during setup was modified'
  rm -- "$sources"

  run_docker_install "$installer" "$apt_dir" appear-fifo
  status=$?
  [[ $status == 1 && -p $sources && ! -e $keyring ]] || die 'a FIFO added during setup was not refused and preserved'
  rm -- "$sources"

  run_docker_install "$installer" "$apt_dir" success
  status=$?
  [[ $status == 0 ]] || die 'a retry after a failed download was refused'
  check_docker_package_steps "$apt_dir"
  grep -Fxq -- "Signed-By: $keyring" "$sources" || die 'a successful installation did not keep its signed repository'
  grep -Fxq -- 'test Docker keyring' "$keyring" || die 'a successful installation did not keep its signing key'

  rm -- "$sources" "$keyring"
  for existing in "$sources" "$keyring" "$legacy_keyring"; do
    printf 'foreign Docker repository file\n' >"$existing"
    run_docker_install "$installer" "$apt_dir" success
    status=$?
    [[ $status == 1 ]] || die "an existing repository file returned $status: $existing"
    grep -q 'Docker repository file already exists' "$apt_dir/output" || die 'existing repository was refused without saying why'
    grep -Fq -- "$sources" "$apt_dir/output" || die 'the refusal did not name the source to reconcile'
    grep -Fq -- "$keyring" "$apt_dir/output" || die 'the refusal did not name the keyring to reconcile'
    grep -Fq -- "$legacy_keyring" "$apt_dir/output" || die 'the refusal did not name the legacy keyring to reconcile'
    grep -q 'remove.*run.*again' "$apt_dir/output" || die 'the refusal did not explain how to retry'
    [[ ! -s $apt_dir/package-steps ]] || die 'package installation was reached despite an existing repository file'
    for path in "$sources" "$keyring" "$legacy_keyring"; do
      if [[ $path == "$existing" ]]; then
        grep -Fxq -- 'foreign Docker repository file' "$path" || die "an existing repository file was modified: $path"
      else
        [[ ! -e $path && ! -L $path ]] || die "a refused installation created a repository file: $path"
      fi
    done
    rm -- "$existing"
  done

  ln -s -- "$apt_dir/missing" "$keyring"
  run_docker_install "$installer" "$apt_dir" success
  status=$?
  [[ $status == 1 && -L $keyring && ! -e $apt_dir/missing ]] || die 'a dangling keyring link was not preserved'
  [[ -z $(find "$apt_dir" -name '.shipkeep-docker.*' -print -quit) ]] || die 'a repository draft was left behind'
)

run_docker_install() {
  local -
  set -m
  (
    set +m
    # shellcheck source=/dev/null
    . "$1"

    local sources=$2/sources.list.d/shipkeep-docker.sources keyring=$2/keyrings/shipkeep-docker.gpg
    local apt_dir=$2 failure=$3 fixture_pid=$BASHPID watchdog deadline_fd
    export TMPDIR="$apt_dir/custom-tmp"
    mkdir -p -- "$TMPDIR"
    : >"$apt_dir/package-steps"
    mkfifo "$2/deadline"
    exec {deadline_fd}<>"$2/deadline"
    rm -- "$2/deadline"
    (
      IFS= read -r -t 10 -u "$deadline_fd" || kill -KILL -- "-$fixture_pid"
    ) &
    watchdog=$!
    trap 'kill "$watchdog" 2>/dev/null || true; wait "$watchdog" 2>/dev/null || true; exec {deadline_fd}>&-' EXIT

    # shellcheck disable=SC2329
    curl() { return 0; }
    # shellcheck disable=SC2329
    single_signing_key() {
      [[ $2 != "$TMPDIR/"* && $(stat -c %a -- "${2%/*}") == 700 ]] || return 1
      [[ $3 == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || return 1
      printf 'test Docker keyring\n' >"$2"
      if [[ $failure == appear-during-setup ]]; then
        printf 'late repository\n' >"$sources"
      elif [[ $failure == appear-fifo ]]; then
        mkfifo "$sources"
      fi
    }
    # shellcheck disable=SC2329
    apt-get() {
      if [[ $1 == update && $failure == fail-update && -f $sources ]]; then
        printf 'Simulated Docker repository update failure\n' >&2
        return 100
      fi
      if [[ " $* " == *' docker-ce '* ]]; then
        printf '%s\n' "$*" >>"$apt_dir/package-steps"
        case $failure in
          fail-download)
            printf 'Simulated Docker download failure\n' >&2
            return 100
            ;;
          signal-*)
            printf 'Simulated Docker download interruption\n' >&2
            kill -s "${failure#signal-}" "$BASHPID"
            ;;
          replace-sources)
            rm -- "$sources"
            printf 'replacement repository\n' >"$sources"
            return 100
            ;;
          replace-keyring)
            rm -- "$keyring"
            printf 'replacement keyring\n' >"$keyring"
            return 100
            ;;
          fail-apply)
            if [[ " $* " != *' --download-only '* ]]; then
              [[ " $* " == *' --no-download '* ]] || return 1
              printf 'Simulated Docker package application failure\n' >&2
              return 100
            fi
            ;;
        esac
      fi
    }

    install_docker_packages "$2"
  ) >"$2/output" 2>&1
  local status=$?
  return "$status"
}

check_docker_package_steps() {
  local -a package_steps=()
  mapfile -t package_steps <"$1/package-steps"
  [[ ${#package_steps[@]} == 2 && " ${package_steps[0]} " == *' --download-only '* && " ${package_steps[1]} " == *' --no-download '* ]] || die 'Docker packages were not downloaded before application'
  [[ ${package_steps[*]} != *Dir::Cache::* ]] || die 'Docker package phases overrode the APT cache'
}
