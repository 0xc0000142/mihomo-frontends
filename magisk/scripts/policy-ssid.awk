function emit(info, ssid, boundary) {
    if (info !~ /Supplicant state: COMPLETED([, ]|$)/) return "+"
    sub(/^[ \t]*mWifiInfo[ :]*/, "", info)
    sub(/^WifiInfo: */, "", info)
    if (info !~ /^SSID: /) return "?"
    sub(/^SSID: /, "", info)
    if (substr(info,1,1)=="\"") {
        boundary=match(info, /", BSSID: ([0-9a-fA-F][0-9a-fA-F]:|<none>|null)/)
        if (boundary) boundary++
    } else boundary=match(info, /, BSSID: ([0-9a-fA-F][0-9a-fA-F]:|<none>|null)/)
    if (!boundary) return "?"
    ssid=substr(info,1,boundary-1)
    if (ssid=="<unknown ssid>" || ssid=="\"<unknown ssid>\"") return "+"
    if (substr(ssid,1,1)=="\"" && substr(ssid,length(ssid),1)=="\"") ssid=substr(ssid,2,length(ssid)-2)
    return "+" ssid
}
source=="cmd" {
    if ($0 ~ /Unknown command|not found|Exception|Permission Denial/) bad=1
    if ($0 ~ /^Wifi is (disabled|not connected)/) disconnected=1
    if ($0 ~ /^WifiInfo: SSID: /) { result=emit($0); count++ }
}
source=="dumpsys" && /^[ \t]*mWifiInfo:?[ ]+SSID: / {
    candidate=emit($0)
    if (candidate!="+" && candidate!="?") { result=candidate; count++ }
    else disconnected=1
}
END {
    if (bad || count>1) print "?"
    else if (count==1) print result
    else if (disconnected) print "+"
    else print "?"
}
