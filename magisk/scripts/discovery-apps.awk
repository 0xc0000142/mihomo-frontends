mode=="normalize" {
    sub(/\r$/, "")
    if ($0 ~ /^[ \t]*$/) next
    if ($0 !~ /^package:/) { invalid=1; next }
    package_name=$1
    sub(/^package:/, "", package_name)
    if (package_name !~ /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/) { invalid=1; next }
    package_uid="null"
    if (NF>2 || (NF==2 && $2 !~ /^uid:[0-9]+$/)) { invalid=1; next }
    if (NF==2) {
        package_uid=substr($2,5)
        if (length(package_uid)>10 || package_uid+0>4294967294) { invalid=1; next }
        package_uid=sprintf("%.0f",package_uid+0)
    }
    print package_name "\t" package_uid
    count++
}
mode=="json" && scope=="system" { system_packages[$1]=1 }
mode=="json" && scope=="all" {
    package_name=$1
    if (!(package_name in packages)) {
        ordered[++count]=package_name
        packages[package_name]=$2
    } else if (packages[package_name]!=$2) packages[package_name]="null"
}
END {
    if (mode=="normalize") exit (invalid || (scope=="all" && count==0))
    printf "{\"ok\":true,\"apps\":["
    for (position=1; position<=count; position++) {
        package_name=ordered[position]
        printf "%s{\"packageName\":\"%s\",\"appLabel\":\"%s\",\"isSystem\":%s,\"uid\":%s}", \
            (position>1?",":""),package_name,package_name,(package_name in system_packages?"true":"false"),packages[package_name]
    }
    print "],\"source\":\"package-manager\"}"
}
