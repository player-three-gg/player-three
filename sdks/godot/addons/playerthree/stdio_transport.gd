# Copyright 2026 The PlayerThree authors
# SPDX-License-Identifier: Apache-2.0

## Spawns the sidecar host as a child process and carries bytes over its stdin/stdout (SPEC §20.8 stdio).
##
## Godot 4 has no Unix-socket or named-pipe client, and a non-blocking [method OS.execute_with_pipe]
## pipe silently drops the unwritten part of a large write. So the pipes stay blocking: one thread
## blocks on the child's stdout and queues chunks, another forwards its stderr (the host's log) to
## Godot's stderr, and writes from the main thread block until the host has read them.
extends RefCounted

const READ_CHUNK := 65536

var _stdio: FileAccess
var _stderr: FileAccess
var _pid := -1
var _reader: Thread
var _logger: Thread
var _mutex := Mutex.new()
var _signal := Semaphore.new()
var _inbox: Array[PackedByteArray] = []
var _eof := false
var _closing := false
var _forward_stderr := true
var _exit_code := -1


## Starts [param program] with [param arguments]. [param forward_stderr] copies the child's stderr lines
## to Godot's stderr.
func start(program: String, arguments: PackedStringArray, forward_stderr: bool) -> Error:
	if _pid != -1:
		return ERR_ALREADY_IN_USE
	var pipes := OS.execute_with_pipe(program, arguments, true)
	if pipes.is_empty():
		return ERR_CANT_CREATE
	_stdio = pipes["stdio"]
	_stderr = pipes["stderr"]
	_pid = pipes["pid"]
	_forward_stderr = forward_stderr
	_reader = Thread.new()
	_reader.start(_read_stdout)
	_logger = Thread.new()
	_logger.start(_read_stderr)
	return OK


## The child's process id, or -1 before [method start].
func pid() -> int:
	return _pid


## Removes and returns every chunk received so far, oldest first. Never blocks.
func take() -> Array[PackedByteArray]:
	_mutex.lock()
	var chunks := _inbox
	_inbox = []
	_mutex.unlock()
	return chunks


## Whether the child closed its stdout (no more chunks will arrive after those still queued).
func at_eof() -> bool:
	_mutex.lock()
	var eof := _eof
	_mutex.unlock()
	return eof


## Blocks until a chunk or EOF arrives or [param timeout_usec] passes. Spurious early returns are allowed.
func wait(timeout_usec: int) -> void:
	var deadline := Time.get_ticks_usec() + timeout_usec
	while not _signal.try_wait():
		if Time.get_ticks_usec() >= deadline:
			return
		OS.delay_usec(100)


## Writes all of [param bytes] to the child's stdin; false once the pipe is closed or broken.
func write(bytes: PackedByteArray) -> bool:
	if _stdio == null or _closing:
		return false
	return _stdio.store_buffer(bytes)


## Closes our ends of the pipes, so the host sees EOF on its stdin and exits; kills it if it is still
## running after [param grace_msec]. Returns the child's exit code (-1 when killed or unknown).
func close(grace_msec: int) -> int:
	if _pid == -1:
		return _exit_code
	_mutex.lock()
	_closing = true
	_mutex.unlock()
	if _stdio != null:
		_stdio.close()
	var deadline := Time.get_ticks_msec() + grace_msec
	while OS.is_process_running(_pid) and Time.get_ticks_msec() < deadline:
		OS.delay_msec(10)
	if OS.is_process_running(_pid):
		OS.kill(_pid)
	else:
		_exit_code = OS.get_process_exit_code(_pid)
	_reader.wait_to_finish()
	_logger.wait_to_finish()
	_stderr.close()
	_stdio = null
	_stderr = null
	_pid = -1
	return _exit_code


## Whether the child is still running.
func running() -> bool:
	return _pid != -1 and OS.is_process_running(_pid)


func _read_stdout() -> void:
	while true:
		# Blocking pipe: an empty read means the child closed stdout (or we closed ours).
		var chunk := _stdio.get_buffer(READ_CHUNK)
		_mutex.lock()
		var stop := chunk.is_empty() or _closing
		if not chunk.is_empty() and not _closing:
			_inbox.append(chunk)
		if stop:
			_eof = true
		_mutex.unlock()
		_signal.post()
		if stop:
			return


func _read_stderr() -> void:
	var line := PackedByteArray()
	while true:
		var chunk := _stderr.get_buffer(READ_CHUNK)
		if chunk.is_empty():
			break
		if not _forward_stderr:
			continue
		line.append_array(chunk)
		var nl := line.find(10)
		while nl != -1:
			printerr("[playerthree-sidecar] ", line.slice(0, nl).get_string_from_utf8())
			line = line.slice(nl + 1)
			nl = line.find(10)
	if _forward_stderr and not line.is_empty():
		printerr("[playerthree-sidecar] ", line.get_string_from_utf8())
