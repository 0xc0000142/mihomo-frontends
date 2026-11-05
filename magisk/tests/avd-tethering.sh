#!/system/bin/sh
set -eu
namespace=mihomo-module-test
interface=mh-test0
peer=mh-peer0
original_forward=$(cat /proc/sys/net/ipv4/ip_forward)
cleanup() {
  iptables -t nat -D POSTROUTING -s 192.0.2.0/24 -o wlan0 -j MASQUERADE 2>/dev/null || true
  iptables -D FORWARD -i "$interface" -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -o "$interface" -j ACCEPT 2>/dev/null || true
  ip rule del priority 9000 iif "$interface" lookup 109 2>/dev/null || true
  ip rule del priority 9001 to 192.0.2.0/24 lookup 109 2>/dev/null || true
  ip route flush table 109 2>/dev/null || true
  ip link del "$interface" 2>/dev/null || true
  ip netns del "$namespace" 2>/dev/null || true
  echo "$original_forward" >/proc/sys/net/ipv4/ip_forward
}
test ! -e "/var/run/netns/$namespace"
if ip link show "$interface" >/dev/null 2>&1; then echo 'Test interface already exists' >&2; exit 1; fi
trap cleanup EXIT HUP INT TERM
ip netns add "$namespace"
ip link add "$interface" type veth peer name "$peer"
ip link set "$peer" netns "$namespace"
ip addr add 192.0.2.1/24 dev "$interface"
ip link set "$interface" up
ip netns exec "$namespace" ip link set lo up
ip netns exec "$namespace" ip addr add 192.0.2.2/24 dev "$peer"
ip netns exec "$namespace" ip link set "$peer" up
ip netns exec "$namespace" ip route add default via 192.0.2.1
ip route add 192.0.2.0/24 dev "$interface" table 109
ip route add default via 10.0.2.2 dev wlan0 table 109
ip rule add priority 9000 iif "$interface" lookup 109
ip rule add priority 9001 to 192.0.2.0/24 lookup 109
echo 1 >/proc/sys/net/ipv4/ip_forward
iptables -t nat -I POSTROUTING -s 192.0.2.0/24 -o wlan0 -j MASQUERADE
iptables -I FORWARD -i "$interface" -j ACCEPT
iptables -I FORWARD -o "$interface" -j ACCEPT
scripts=/data/adb/modules/mihomo-ebpf/scripts
sh "$scripts/policy.sh" set 0 0 bWgtdGVzdDA= Y29tLmFuZHJvaWQuc2hlbGw= off ''
sh "$scripts/mihomo.sh" start
sleep 2
ip netns exec "$namespace" curl -sS -m 8 -o /dev/null -w 'tethering-off HTTP=%{http_code}\n' http://1.1.1.1
sh "$scripts/policy.sh" set 0 1 bWgtdGVzdDA= Y29tLmFuZHJvaWQuc2hlbGw= off ''
sleep 2
ip netns exec "$namespace" curl -sS -m 8 -o /dev/null -w 'tethering-on HTTP=%{http_code}\n' http://1.1.1.1 || true
sh "$scripts/policy.sh" set 0 0 bWgtdGVzdDA= Y29tLmFuZHJvaWQuc2hlbGw= off ''
sleep 2
ip netns exec "$namespace" curl -sS -m 8 -o /dev/null -w 'tethering-off-again HTTP=%{http_code}\n' http://1.1.1.1
