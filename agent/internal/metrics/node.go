package metrics

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	agentv1 "github.com/shipkeepdev/shipkeep/lib/gen/shipkeep/agent/v1"
)

// clockTicks is USER_HZ, the unit of /proc/stat: 100 on every Linux architecture Shipkeep supports.
const clockTicks = 100

// readNode reads the node's CPU time and core count from proc/stat, its memory from
// proc/meminfo and the traffic of its physical interfaces from proc/net/dev.
func readNode(proc string) (*agentv1.NodeMetrics, error) {
	node := &agentv1.NodeMetrics{}
	stat, err := readFile(filepath.Join(proc, "stat"))
	if err != nil {
		return nil, err
	}
	if node.CpuSeconds, node.CpuCores, err = cpu(stat); err != nil {
		return nil, err
	}
	meminfo, err := readFile(filepath.Join(proc, "meminfo"))
	if err != nil {
		return nil, err
	}
	if node.MemoryTotalBytes, node.MemoryUsedBytes, err = memory(meminfo); err != nil {
		return nil, err
	}
	dev, err := readFile(filepath.Join(proc, "net", "dev"))
	if err != nil {
		return nil, err
	}
	node.NetworkReceivedBytes, node.NetworkSentBytes = traffic(dev)
	return node, nil
}

// readFile reads at most 1 MiB: proc files of interest are far smaller.
func readFile(path string) ([]byte, error) {
	file, err := os.Open(path) //nolint:gosec // a fixed proc path below the configured root
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	defer file.Close() //nolint:errcheck // read-only
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filepath.Base(path), err)
	}
	return data, nil
}

var errFormat = errors.New("unexpected proc format")

// cpu reads the busy time of the `cpu` line (user, nice, system, irq, softirq and steal; guest
// time is already in user) and counts the `cpuN` lines.
func cpu(stat []byte) (float64, uint32, error) {
	var busy uint64
	var cores uint32
	found := false
	scanner := bufio.NewScanner(bytes.NewReader(stat))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 || !strings.HasPrefix(fields[0], "cpu") {
			continue
		}
		if fields[0] != "cpu" {
			cores++
			continue
		}
		if len(fields) < 9 {
			return 0, 0, errFormat
		}
		for _, index := range []int{1, 2, 3, 6, 7, 8} {
			ticks, err := strconv.ParseUint(fields[index], 10, 64)
			if err != nil {
				return 0, 0, errFormat
			}
			busy += ticks
		}
		found = true
	}
	if !found || cores == 0 {
		return 0, 0, errFormat
	}
	return float64(busy) / clockTicks, cores, nil
}

// memory reads MemTotal and MemAvailable: what is in use is the rest.
func memory(meminfo []byte) (total, used uint64, err error) {
	values := map[string]uint64{}
	scanner := bufio.NewScanner(bytes.NewReader(meminfo))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 || fields[2] != "kB" {
			continue
		}
		kibibytes, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil || kibibytes > 1<<44 {
			continue
		}
		values[strings.TrimSuffix(fields[0], ":")] = kibibytes * 1024
	}
	total, available := values["MemTotal"], values["MemAvailable"]
	if total == 0 || available > total {
		return 0, 0, errFormat
	}
	return total, total - available, nil
}

// virtual names the interfaces that do not leave the machine: loopback, Docker's bridges and the
// ends of container links, other bridges, and the private WireGuard network.
func virtual(name string) bool {
	if name == "lo" {
		return true
	}
	for _, prefix := range []string{"docker", "br-", "veth", "virbr", "cni", "flannel", "shipkeep"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

// traffic sums the bytes received and sent by the physical interfaces of proc/net/dev.
func traffic(dev []byte) (received, sent uint64) {
	scanner := bufio.NewScanner(bytes.NewReader(dev))
	for scanner.Scan() {
		name, counters, found := strings.Cut(scanner.Text(), ":")
		name = strings.TrimSpace(name)
		if !found || virtual(name) {
			continue
		}
		fields := strings.Fields(counters)
		if len(fields) < 16 {
			continue
		}
		in, errIn := strconv.ParseUint(fields[0], 10, 64)
		out, errOut := strconv.ParseUint(fields[8], 10, 64)
		if errIn != nil || errOut != nil {
			continue
		}
		received += in
		sent += out
	}
	return received, sent
}

// disk reads the size and the use of the file system that holds path.
func disk(path string) (total, used uint64, err error) {
	var fs unix.Statfs_t
	if err := unix.Statfs(path, &fs); err != nil {
		return 0, 0, fmt.Errorf("statfs: %w", err)
	}
	blockSize := uint64(fs.Bsize) //nolint:gosec // a block size is positive
	total = fs.Blocks * blockSize
	used = (fs.Blocks - fs.Bfree) * blockSize
	return total, used, nil
}
