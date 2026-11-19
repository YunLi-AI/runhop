runhop_fail() {
    printf '[RunHop] %s\n' "$*" >&2
    exit 1
}

# This file runs in the user's interactive login shell, after its startup files.
stty echo || runhop_fail "Cannot configure the remote terminal."

if [[ -n "${ZSH_VERSION:-}" ]]; then
    runhop_shell=zsh
    runhop_find() { whence -p -- "$1"; }
else
    runhop_shell=bash
    runhop_find() { type -P -- "$1"; }
fi

if [[ "$RUNHOP_TERMINAL_PYTHON" == /* ]]; then
    runhop_python=$RUNHOP_TERMINAL_PYTHON
else
    runhop_python=$(runhop_find "$RUNHOP_TERMINAL_PYTHON") ||
        runhop_fail "Cannot find the configured Python: $RUNHOP_TERMINAL_PYTHON"
fi
[[ -f "$runhop_python" && -x "$runhop_python" ]] ||
    runhop_fail "The configured Python is not executable: $runhop_python"
runhop_bin=$(cd -- "$(dirname -- "$runhop_python")" && pwd -P) ||
    runhop_fail "Cannot resolve the Python executable directory."
runhop_prefix=$(dirname -- "$runhop_bin")

if [[ -d "$runhop_prefix/conda-meta" ]]; then
    runhop_base=$runhop_prefix
    while [[ "$runhop_base" != / && ! -r "$runhop_base/etc/profile.d/conda.sh" ]]; do
        runhop_base=$(dirname -- "$runhop_base")
    done
    if [[ -n "${RUNHOP_TERMINAL_CONDA:-}" ]]; then
        runhop_conda=$RUNHOP_TERMINAL_CONDA
        runhop_hook=$("$runhop_conda" "shell.$runhop_shell" hook) ||
            runhop_fail "Cannot initialize Conda using $runhop_conda."
        eval "$runhop_hook" || runhop_fail "The Conda shell hook failed."
    elif typeset -f conda >/dev/null; then
        : # The user's login files already initialized Conda.
    elif [[ -r "$runhop_base/etc/profile.d/conda.sh" ]]; then
        source "$runhop_base/etc/profile.d/conda.sh" ||
            runhop_fail "Cannot initialize Conda from $runhop_base."
    else
        runhop_conda=${CONDA_EXE:-$(runhop_find conda)}
        [[ -n "$runhop_conda" ]] ||
            runhop_fail "Cannot locate Conda for $runhop_prefix. Set condaExecutable on this RunHop interpreter or initialize Conda in the login shell."
        runhop_hook=$("$runhop_conda" "shell.$runhop_shell" hook) ||
            runhop_fail "Cannot initialize Conda for $runhop_prefix."
        eval "$runhop_hook" || runhop_fail "The Conda shell hook failed."
    fi
    conda activate "$runhop_prefix" || runhop_fail "Cannot activate $runhop_prefix."
elif [[ -f "$runhop_prefix/pyvenv.cfg" ]]; then
    [[ -r "$runhop_bin/activate" ]] || runhop_fail "Cannot find $runhop_bin/activate."
    source "$runhop_bin/activate" || runhop_fail "Cannot activate $runhop_prefix."
elif [[ "$RUNHOP_TERMINAL_PYTHON" == /* ]]; then
    export PATH="$runhop_bin:$PATH"
fi

cd -- "$RUNHOP_TERMINAL_CWD" ||
    runhop_fail "Cannot open the remote directory: $RUNHOP_TERMINAL_CWD"
hash -r
printf '\033]777;runhop:%s\007' "$RUNHOP_TERMINAL_TOKEN"
unset RUNHOP_TERMINAL_PYTHON RUNHOP_TERMINAL_CWD RUNHOP_TERMINAL_CONDA RUNHOP_TERMINAL_TOKEN RUNHOP_TERMINAL_INIT
unset runhop_python runhop_bin runhop_prefix runhop_base runhop_conda runhop_hook runhop_shell
unset -f runhop_fail runhop_find
